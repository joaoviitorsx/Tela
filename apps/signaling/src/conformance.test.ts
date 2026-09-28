import { describe, expect, it } from 'vitest';
import { makeNodeDriver } from './testing-node-driver.js';
import { makeWorkerDriver } from './testing-worker-driver.js';
import {
  CONVITE,
  OUTRO,
  OUTRO_CONVITE,
  OWNER,
  SLUG,
  type ConformanceDriver,
  errorOf,
  ofType,
  peerIdOf,
} from './conformance.js';

/**
 * A MESMA bateria roda contra as duas implementações.
 *
 * Se um comportamento mudar só de um lado, este arquivo quebra — que é o
 * único jeito honesto de manter duas implementações do mesmo protocolo sem
 * que elas divirjam com o tempo.
 */
const implementacoes: [string, () => ConformanceDriver][] = [
  ['node + ws', makeNodeDriver],
  ['cloudflare durable object', makeWorkerDriver],
];

describe.each(implementacoes)('conformidade — %s', (_nome, criar) => {
  it('transmissor entra e recebe iceServers e teto de peers', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);

    const first = host.received()[0];
    expect(first?.type).toBe('hosting');
    if (first?.type !== 'hosting') return;
    expect(Array.isArray(first.iceServers)).toBe(true);
    expect(first.relayStatus).toBe('not-configured');
    expect(first.maxPeers).toBeGreaterThanOrEqual(1);
  });

  it('o ownerToken nunca volta para o cliente', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    expect(JSON.stringify(host.received())).not.toContain(OWNER);
  });

  it('slug fora do formato é recusado', async () => {
    const d = criar();
    const host = await d.host('h', '-x-', OWNER);
    expect(errorOf(host)).toBe('SLUG_INVALID');
    expect(host.closed()).toBe(true);
  });

  it('a blocklist vale no SERVIDOR, não só no formulário', async () => {
    // Pelo WebSocket cru não existe formulário: qualquer um pediria `api` ou
    // `admin` direto. A validação do cliente é conveniência, não defesa.
    const d = criar();
    for (const proibido of ['api', 'admin', 'signal', 'transmitir', 'recuperar']) {
      const host = await d.host(`h-${proibido}`, proibido, OWNER);
      expect(errorOf(host)).toBe('SLUG_INVALID');
    }
  });

  it('espectador sem transmissor recebe NOT_HOSTING', async () => {
    const d = criar();
    expect(errorOf(await d.watch('v', SLUG))).toBe('NOT_HOSTING');
  });

  it('slug inexistente e slug offline dão o mesmo erro', async () => {
    const d = criar();
    const a = await d.watch('a', SLUG);
    const b = await d.watch('b', 'outro-canal');
    expect(errorOf(a)).toBe(errorOf(b));
  });

  it('outro dono no mesmo slug é recusado', async () => {
    const d = criar();
    await d.host('h', SLUG, OWNER);
    expect(errorOf(await d.host('intruso', SLUG, OUTRO))).toBe('SLUG_TAKEN');
  });

  it('o mesmo dono reconecta e derruba o socket antigo', async () => {
    const d = criar();
    const primeiro = await d.host('h1', SLUG, OWNER);
    const segundo = await d.host('h2', SLUG, OWNER);
    expect(primeiro.closed()).toBe(true);
    expect(segundo.received()[0]?.type).toBe('hosting');
  });

  it('transmissor é avisado quando um espectador entra', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);
    expect(ofType(host, 'peer-joined')).toEqual([
      { type: 'peer-joined', peerId: peerIdOf(viewer) },
    ]);
  });

  it('espectador recebe o id do transmissor', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);
    const first = viewer.received()[0];
    expect(first?.type === 'watching' && first.hostId).toBe(peerIdOf(host));
  });

  it('R8: payload atravessa intacto, do transmissor ao espectador', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);

    // Estrutura arbitrária e aninhada: o servidor não pode entender nada disso.
    const payload = { description: { type: 'offer', sdp: 'v=0' }, extra: [1, { z: true }] };
    await d.signal('h', payload, peerIdOf(viewer));

    expect(ofType(viewer, 'signal')).toEqual([
      { type: 'signal', from: peerIdOf(host), payload },
    ]);
  });

  it('espectador não precisa endereçar — vai sempre ao transmissor', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);
    await d.signal('v', { candidate: { candidate: 'c1' } });

    expect(ofType(host, 'signal')).toEqual([
      { type: 'signal', from: peerIdOf(viewer), payload: { candidate: { candidate: 'c1' } } },
    ]);
  });

  it('espectador não alcança outro espectador', async () => {
    const d = criar();
    await d.host('h', SLUG, OWNER);
    await d.watch('v1', SLUG);
    const v2 = await d.watch('v2', SLUG);
    await d.signal('v1', 'malicioso', peerIdOf(v2));
    expect(ofType(v2, 'signal')).toEqual([]);
  });

  it('sinal antes de entrar no canal é recusado', async () => {
    const d = criar();
    const solto = await d.watch('solto', 'canal-vazio');
    await d.signal('solto', 'oi');
    expect(ofType(solto, 'signal')).toEqual([]);
  });

  it('aplica o teto de espectadores', async () => {
    const d = criar();
    await d.host('h', SLUG, OWNER);
    await d.watch('v1', SLUG);
    await d.watch('v2', SLUG);
    await d.watch('v3', SLUG);
    expect(errorOf(await d.watch('v4', SLUG))).toBe('CHANNEL_FULL');
  });

  it('uma nova tentativa do mesmo participante substitui a vaga sem expulsar outros', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const participantId = 'p'.repeat(32);
    const first = await d.watch('v1', SLUG, { participantId, attemptId: 'a'.repeat(32) });
    await d.watch('v2', SLUG);
    await d.watch('v3', SLUG);
    d.hibernar?.();
    const replacement = await d.watch('v1-next', SLUG, { participantId, attemptId: 'b'.repeat(32) });
    expect(first.closed()).toBe(true);
    expect(peerIdOf(replacement)).toBe(peerIdOf(first));
    expect(ofType(host, 'peer-left')).toEqual([]);
    expect(ofType(host, 'peer-joined').at(-1)).toEqual({
      type: 'peer-joined', peerId: peerIdOf(first), attemptId: 'b'.repeat(32),
    });
    expect(errorOf(await d.watch('v4', SLUG))).toBe('CHANNEL_FULL');
  });

  it('renova ICE para a própria conexão sem criar participante ou repassar sinal', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);
    d.hibernar?.();
    await d.refreshIce('v', 'request-1');
    const initial = ofType(viewer, 'watching')[0];
    expect(ofType(viewer, 'ice-servers')).toEqual([{
      type: 'ice-servers', requestId: 'request-1',
      iceServers: initial?.iceServers, relayStatus: 'not-configured',
    }]);
    expect(ofType(host, 'signal')).toEqual([]);
    expect(ofType(host, 'peer-joined')).toHaveLength(1);
  });

  it('saída de espectador avisa o transmissor e libera a vaga', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);
    const id = peerIdOf(viewer);

    d.disconnect('v');
    expect(ofType(host, 'peer-left')).toEqual([{ type: 'peer-left', peerId: id }]);

    // A vaga voltou: um espectador novo entra.
    expect(errorOf(await d.watch('novo', SLUG))).toBeUndefined();
  });

  it('saída ANUNCIADA do transmissor AVISA os espectadores antes de derrubar', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);
    await d.leave('h');
    d.disconnect('h');

    // Socket fechado em silêncio não distingue "o transmissor saiu" de "o
    // servidor caiu" — e o espectador ficava "assistindo" vídeo congelado.
    expect(ofType(viewer, 'peer-left')).toEqual([
      { type: 'peer-left', peerId: peerIdOf(host) },
    ]);
    expect(viewer.closed()).toBe(true);
  });

  /**
   * As duas implementações precisam concordar nisto, e é a promessa central da
   * arquitetura: o servidor não está no caminho da mídia, logo não deveria
   * estar no caminho da falha. Socket do transmissor que cai — piscada de rede,
   * deploy nosso — não pode apagar uma transmissão que continua fluindo P2P.
   */
  it('QUEDA do socket do transmissor NÃO derruba os espectadores', async () => {
    const d = criar();
    await d.host('h', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);
    d.disconnect('h');

    expect(ofType(viewer, 'peer-left')).toEqual([]);
    expect(viewer.closed()).toBe(false);
  });

  it('destino inexistente é ignorado, não derruba a conexão', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    // Espectador que saiu no exato momento em que a oferta ia sair. Acontece.
    await d.signal('h', { description: { type: 'offer', sdp: 'v=0' } }, 'v_fantasma');
    expect(host.closed()).toBe(false);
    expect(errorOf(host)).toBeUndefined();
  });

  it('substituir o host NÃO derruba os espectadores', async () => {
    const d = criar();
    await d.host('h1', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);
    await d.host('h2', SLUG, OWNER);

    // Reconexão do dono (refresh, troca de rede) não pode custar a audiência.
    expect(viewer.closed()).toBe(false);
  });

  it('mensagem fora do schema é recusada e fecha a conexão', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    // `signal` sem payload: o JSON.stringify some com a chave e o schema
    // recusa. As duas implementações precisam concordar até nisso.
    await d.signal('h', undefined, 'alguem');
    expect(errorOf(host)).toBe('BAD_MESSAGE');
    expect(host.closed()).toBe(true);
  });
});


/**
 * Hibernação — só a implementação em Durable Object tem.
 *
 * Este bloco existe porque o motivo de haver uma SEGUNDA implementação é
 * justamente a hibernação, e ela nunca era exercitada: o driver reconstruía
 * nada e o estado em memória sempre sobrevivia nos testes. Foi exatamente
 * nesse caminho não testado que um estranho conseguia assumir um canal ao
 * vivo.
 */
describe.each(implementacoes.filter(([, criar]) => criar().hibernar !== undefined))(
  'hibernação — %s',
  (_nome, criar) => {
    it('o dono do canal SOBREVIVE ao despejo de memória', async () => {
      const d = criar();
      await d.host('h', SLUG, OWNER);

      d.hibernar?.();

      // Antes, o ownerHash morava numa variável de instância. Depois do
      // despejo ele voltava null, a checagem de dono passava a aceitar
      // qualquer um, e o intruso derrubava o transmissor e assumia o canal.
      const intruso = await d.host('x', SLUG, OUTRO);
      expect(errorOf(intruso)).toBe('SLUG_TAKEN');
    });

    it('o dono verdadeiro reassume depois do despejo', async () => {
      const d = criar();
      const primeiro = await d.host('h1', SLUG, OWNER);
      d.hibernar?.();

      const segundo = await d.host('h2', SLUG, OWNER);
      expect(errorOf(segundo)).toBeUndefined();
      expect(primeiro.closed()).toBe(true);
    });

    it('espectadores continuam no canal depois do despejo', async () => {
      const d = criar();
      const host = await d.host('h', SLUG, OWNER);
      const viewer = await d.watch('v', SLUG);

      d.hibernar?.();

      // O roteamento precisa continuar funcionando a partir dos attachments.
      await d.signal('h', { candidate: 'depois do despejo' }, peerIdOf(viewer));
      expect(ofType(viewer, 'signal')).toEqual([
        { type: 'signal', from: peerIdOf(host), payload: { candidate: 'depois do despejo' } },
      ]);
    });

    it('o teto de espectadores continua valendo depois do despejo', async () => {
      const d = criar();
      await d.host('h', SLUG, OWNER);
      await d.watch('v1', SLUG);
      await d.watch('v2', SLUG);

      d.hibernar?.();

      await d.watch('v3', SLUG);
      expect(errorOf(await d.watch('v4', SLUG))).toBe('CHANNEL_FULL');
    });

    it('a posse resiste à saída do host, dentro da carência', async () => {
      const d = criar();
      await d.host('h', SLUG, OWNER);
      d.disconnect('h');
      d.hibernar?.();

      // Um refresh de página não pode entregar o slug — o link já foi mandado
      // para os amigos.
      expect(errorOf(await d.host('x', SLUG, OUTRO))).toBe('SLUG_TAKEN');
      expect(errorOf(await d.host('h2', SLUG, OWNER))).toBeUndefined();
    });
  },
);

it('Worker libera reserva e não envia watching depois do socket fechar durante TURN', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let viewersIssued = 0;
  const d = makeWorkerDriver(async (peerId) => {
    if (peerId.startsWith('v') && ++viewersIssued === 1) await gate;
    return { servers: [{ urls: ['stun:test'] }], relayStatus: 'not-configured' };
  });
  const host = await d.host('h', SLUG, OWNER);
  const pending = d.watch('v1', SLUG);
  await d.watch('v2', SLUG);
  await d.watch('v3', SLUG);
  expect(errorOf(await d.watch('v4', SLUG))).toBe('CHANNEL_FULL');
  d.disconnect('v1');
  release();
  const abandoned = await pending;
  expect(ofType(abandoned, 'watching')).toEqual([]);
  expect(errorOf(await d.watch('v4-next', SLUG))).toBeUndefined();
  expect(ofType(host, 'peer-joined')).toHaveLength(3);
});

it('Worker espera TURN antes de reapresentar a reserva ao host reconectado', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const d = makeWorkerDriver(async (peerId) => {
    if (peerId.startsWith('v')) await gate;
    return { servers: [{ urls: ['stun:test'] }], relayStatus: 'not-configured' };
  });
  await d.host('h1', SLUG, OWNER);
  const pending = d.watch('v', SLUG);
  const newHost = await d.host('h2', SLUG, OWNER);
  expect(ofType(newHost, 'peer-joined')).toEqual([]);
  release();
  const viewer = await pending;
  expect(ofType(viewer, 'watching')[0]?.hostId).toBe(peerIdOf(newHost));
  expect(ofType(newHost, 'peer-joined')).toEqual([
    { type: 'peer-joined', peerId: peerIdOf(viewer) },
  ]);
});

describe.each(implementacoes)('convite privado e protocolo versionado (TELA-018) — %s', (_nome, criar) => {
  it('espectador sem convite não entra, nem recebe vaga ou ICE', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const v = await d.watch('v', SLUG, undefined, { invite: null });
    expect(errorOf(v)).toBe('INVITE_INVALID');
    expect(ofType(v, 'watching')).toEqual([]);
    expect(ofType(host, 'peer-joined')).toEqual([]);
    expect(v.closed()).toBe(true);
  });

  it('convite errado é recusado; o certo entra', async () => {
    const d = criar();
    await d.host('h', SLUG, OWNER);
    const errado = await d.watch('v1', SLUG, undefined, { invite: OUTRO_CONVITE });
    expect(errorOf(errado)).toBe('INVITE_INVALID');
    const certo = await d.watch('v2', SLUG);
    expect(ofType(certo, 'watching')).toHaveLength(1);
  });

  it('sem transmissão, convite errado e inexistente dão o mesmo NOT_HOSTING', async () => {
    const d = criar();
    const semNada = await d.watch('v1', SLUG, undefined, { invite: OUTRO_CONVITE });
    expect(errorOf(semNada)).toBe('NOT_HOSTING');
  });

  it('cliente v1 (sem protocolo) é recusado com código que ele entende — sala nunca abre', async () => {
    const d = criar();
    const hostAntigo = await d.host('h1', SLUG, OWNER, { protocol: null, invite: null });
    expect(errorOf(hostAntigo)).toBe('BAD_MESSAGE');
    await d.host('h2', SLUG, OWNER);
    const antigo = await d.watch('v', SLUG, undefined, { protocol: null, invite: null });
    expect(errorOf(antigo)).toBe('BAD_MESSAGE');
  });

  it('host v2 sem convite não abre sala aberta por omissão', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { invite: null });
    expect(errorOf(host)).toBe('BAD_MESSAGE');
    expect(ofType(host, 'hosting')).toEqual([]);
  });

  it('versão diferente recebe PROTOCOL_MISMATCH', async () => {
    const d = criar();
    const futuro = await d.host('h', SLUG, OWNER, { protocol: 3 });
    expect(errorOf(futuro)).toBe('PROTOCOL_MISMATCH');
  });

  it('renovar convite barra entradas novas e mantém quem já está dentro', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const dentro = await d.watch('v1', SLUG);
    await d.send('h', { type: 'set-invite', invite: OUTRO_CONVITE });
    expect(ofType(host, 'invite-set')).toHaveLength(1);

    const linkVelho = await d.watch('v2', SLUG);
    expect(errorOf(linkVelho)).toBe('INVITE_INVALID');
    const linkNovo = await d.watch('v3', SLUG, undefined, { invite: OUTRO_CONVITE });
    expect(ofType(linkNovo, 'watching')).toHaveLength(1);
    expect(dentro.closed()).toBe(false);
  });

  it('renovar não troca o dono do canal', async () => {
    const d = criar();
    await d.host('h', SLUG, OWNER);
    await d.send('h', { type: 'set-invite', invite: OUTRO_CONVITE });
    const estranho = await d.host('x', SLUG, OUTRO, { invite: OUTRO_CONVITE });
    expect(errorOf(estranho)).toBe('SLUG_TAKEN');
  });

  it('espectador não troca convite nem remove ninguém', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const v1 = await d.watch('v1', SLUG);
    const v2 = await d.watch('v2', SLUG);
    await d.send('v1', { type: 'remove-viewers' });
    expect(errorOf(v1)).toBe('BAD_MESSAGE');
    expect(v2.closed()).toBe(false);
    await d.send('v2', { type: 'set-invite', invite: OUTRO_CONVITE });
    expect(errorOf(v2)).toBe('BAD_MESSAGE');
    expect(ofType(host, 'invite-set')).toEqual([]);
    const aindaEntra = await d.watch('v3', SLUG, undefined, { invite: CONVITE });
    expect(ofType(aindaEntra, 'watching')).toHaveLength(1);
  });

  it('desconectar todos fecha a sinalização de cada um e avisa o transmissor', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const v1 = await d.watch('v1', SLUG);
    const v2 = await d.watch('v2', SLUG);
    await d.send('h', { type: 'remove-viewers' });
    expect(errorOf(v1)).toBe('REMOVED');
    expect(errorOf(v2)).toBe('REMOVED');
    expect(v1.closed() && v2.closed()).toBe(true);
    expect(ofType(host, 'peer-left').map((m) => m.peerId).sort())
      .toEqual([peerIdOf(v1), peerIdOf(v2)].sort());
    // As vagas voltam: a sala comporta de novo.
    const v3 = await d.watch('v3', SLUG);
    expect(ofType(v3, 'watching')[0]?.viewers).toBe(1);
  });

  it('remover um só não mexe nos outros, e não duplica peer-left', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const v1 = await d.watch('v1', SLUG);
    const v2 = await d.watch('v2', SLUG);
    await d.send('h', { type: 'remove-viewers', peerId: peerIdOf(v1) });
    expect(errorOf(v1)).toBe('REMOVED');
    expect(v2.closed()).toBe(false);
    expect(ofType(host, 'peer-left')).toEqual([{ type: 'peer-left', peerId: peerIdOf(v1) }]);
  });

  it('o convite nunca volta para ninguém', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const v = await d.watch('v', SLUG);
    for (const c of [host, v]) expect(JSON.stringify(c.received())).not.toContain(CONVITE);
  });
});

it('Worker: convite inválido não gasta credencial TURN', async () => {
  const pedidos: string[] = [];
  const d = makeWorkerDriver(async (peerId) => {
    pedidos.push(peerId);
    return { servers: [{ urls: ['stun:test'] }], relayStatus: 'not-configured' };
  });
  await d.host('h', SLUG, OWNER);
  const antes = pedidos.length;
  await d.watch('v', SLUG, undefined, { invite: OUTRO_CONVITE });
  expect(pedidos.length).toBe(antes);
});
