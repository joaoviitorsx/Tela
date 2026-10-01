import { P2P_LIMITS, PROTOCOL_VERSION } from '@tela/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from './limits.js';
import { makeNodeDriver } from './testing-node-driver.js';
import { makeWorkerDriver } from './testing-worker-driver.js';
import {
  OUTRO,
  OWNER,
  SLUG,
  type ConformanceDriver,
  chaveDe,
  comAprovacao,
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
type Opcoes = { readonly maxPeers?: number };
const implementacoes: [string, (opcoes?: Opcoes) => ConformanceDriver][] = [
  ['node + ws', (opcoes) => comAprovacao(makeNodeDriver(opcoes))],
  ['cloudflare durable object', (opcoes) => comAprovacao(makeWorkerDriver(undefined, opcoes))],
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
      { type: 'peer-joined', peerId: peerIdOf(viewer), name: 'v', fingerprint: expect.any(String) },
    ]);
  });

  it('espectador recebe o id do transmissor', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);
    expect(ofType(viewer, 'watching')[0]?.hostId).toBe(peerIdOf(host));
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

  /**
   * O teto do canal é do TRANSMISSOR, não do servidor (ADR 0029): quem
   * codifica uma vez por espectador declara cinco; quem tem um encode e N
   * envios declara cinquenta. O servidor só põe o teto por cima.
   */
  describe('capacidade declarada pelo transmissor (ADR 0029)', () => {
    it('sem capacidade (cliente antigo), o teto é o de quem codifica por espectador', async () => {
      const d = criar({ maxPeers: 8 });
      const host = await d.host('h', SLUG, OWNER);
      expect(ofType(host, 'hosting')[0]?.maxPeers).toBe(5);
    });

    it('capacidade 5: o sexto espectador recebe CHANNEL_FULL com o teto real', async () => {
      const d = criar({ maxPeers: 8 });
      const host = await d.host('h', SLUG, OWNER, { capacidade: 5 });
      expect(ofType(host, 'hosting')[0]?.maxPeers).toBe(5);
      for (let i = 1; i <= 5; i += 1) expect(ofType(await d.watch(`v${i}`, SLUG), 'watching')).toHaveLength(1);
      const sexto = await d.watch('v6', SLUG);
      expect(ofType(sexto, 'error')).toEqual([{ type: 'error', code: 'CHANNEL_FULL', maxPeers: 5 }]);
      expect(sexto.closed()).toBe(true);
      expect(ofType(host, 'peer-joined')).toHaveLength(5);
    });

    it('capacidade acima do teto do servidor é cortada no teto do servidor', async () => {
      const d = criar({ maxPeers: 3 });
      const host = await d.host('h', SLUG, OWNER, { capacidade: 5 });
      expect(ofType(host, 'hosting')[0]?.maxPeers).toBe(3);
      for (const id of ['v1', 'v2', 'v3']) await d.watch(id, SLUG);
      expect(ofType(await d.watch('v4', SLUG), 'error')).toEqual([
        { type: 'error', code: 'CHANNEL_FULL', maxPeers: 3 },
      ]);
    });

    it('capacidade inválida é BAD_MESSAGE, como qualquer campo fora do schema', async () => {
      for (const [id, capacidade] of [['zero', 0], ['acima', P2P_LIMITS.maxViewers + 1], ['fracao', 2.5], ['texto', '5']] as const) {
        const d = criar();
        const host = await d.host(id, SLUG, OWNER, { capacidade });
        expect(errorOf(host), id).toBe('BAD_MESSAGE');
        expect(host.closed(), id).toBe(true);
      }
    });

    it('a capacidade vale também na sala com aprovação, inclusive na hora de aceitar', async () => {
      const d = criar({ maxPeers: 8 });
      const host = await d.host('h', SLUG, OWNER, { approval: true, capacidade: 2 });
      const esperando = await d.watch('ana', SLUG, undefined, { aprovar: false });
      const peerId = ofType(host, 'join-request')[0]!.peerId;
      await d.watch('x', SLUG);
      await d.watch('y', SLUG);
      expect(ofType(await d.watch('z', SLUG), 'error')).toEqual([
        { type: 'error', code: 'CHANNEL_FULL', maxPeers: 2 },
      ]);
      await d.send('h', { type: 'admit', peerId });
      expect(ofType(esperando, 'error')).toEqual([{ type: 'error', code: 'CHANNEL_FULL', maxPeers: 2 }]);
    });

    it('o transmissor que reconecta redeclara a capacidade, e ela sobrevive à hibernação', async () => {
      const d = criar({ maxPeers: 8 });
      await d.host('h1', SLUG, OWNER, { capacidade: 1 });
      await d.watch('v1', SLUG);
      expect(errorOf(await d.watch('v2', SLUG))).toBe('CHANNEL_FULL');
      d.disconnect('h1');
      const h2 = await d.host('h2', SLUG, OWNER, { capacidade: 2 });
      expect(ofType(h2, 'hosting')[0]?.maxPeers).toBe(2);
      d.hibernar?.();
      expect(ofType(await d.watch('v3', SLUG), 'watching')).toHaveLength(1);
      expect(errorOf(await d.watch('v4', SLUG))).toBe('CHANNEL_FULL');
    });
  });

  it('uma nova tentativa do mesmo participante substitui a vaga sem expulsar outros', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const participantId = 'p'.repeat(32);
    const first = await d.watch('v1', SLUG, { participantId, attemptId: 'a'.repeat(32) });
    await d.watch('v2', SLUG);
    await d.watch('v3', SLUG);
    d.hibernar?.();
    // Mesmo navegador (mesma chave): retoma sem pedir de novo.
    const replacement = await d.watch(
      'v1-next', SLUG, { participantId, attemptId: 'b'.repeat(32) }, { viewerKey: chaveDe('v1') },
    );
    expect(first.closed()).toBe(true);
    expect(peerIdOf(replacement)).toBe(peerIdOf(first));
    expect(ofType(host, 'peer-left')).toEqual([]);
    expect(ofType(host, 'peer-joined').at(-1)).toEqual({
      type: 'peer-joined', peerId: peerIdOf(first), attemptId: 'b'.repeat(32),
      name: 'v1-next', fingerprint: expect.any(String),
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
  const d = comAprovacao(makeWorkerDriver(async (peerId) => {
    if (peerId.startsWith('v') && ++viewersIssued === 1) await gate;
    return { servers: [{ urls: ['stun:test'] }], relayStatus: 'not-configured' };
  }));
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
  const d = comAprovacao(makeWorkerDriver(async (peerId) => {
    if (peerId.startsWith('v')) await gate;
    return { servers: [{ urls: ['stun:test'] }], relayStatus: 'not-configured' };
  }));
  await d.host('h1', SLUG, OWNER);
  const pending = d.watch('v', SLUG);
  const newHost = await d.host('h2', SLUG, OWNER);
  expect(ofType(newHost, 'peer-joined')).toEqual([]);
  release();
  const viewer = await pending;
  expect(ofType(viewer, 'watching')[0]?.hostId).toBe(peerIdOf(newHost));
  expect(ofType(newHost, 'peer-joined')).toEqual([
    { type: 'peer-joined', peerId: peerIdOf(viewer), name: 'v', fingerprint: expect.any(String) },
  ]);
});

describe.each(implementacoes)('link só com o nome, sala aberta e protocolo versionado (ADR 0026/0028) — %s', (_nome, criar) => {
  it('sala aberta (padrão, ADR 0028): quem tem o link entra direto, sem apelido nem chave', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const v = await d.watch('v', SLUG, undefined, { aprovar: false, name: null, viewerKey: null });
    expect(ofType(v, 'awaiting-approval')).toEqual([]);
    expect(ofType(v, 'watching')).toHaveLength(1);
    expect(ofType(host, 'join-request')).toEqual([]);
    expect(ofType(host, 'peer-joined')).toEqual([{ type: 'peer-joined', peerId: peerIdOf(v) }]);
  });

  it('sala aberta: o mesmo participante retoma a vaga sem duplicar', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const participantId = 'p'.repeat(32);
    const primeiro = await d.watch('v1', SLUG, { participantId, attemptId: 'a'.repeat(32) }, { name: null, viewerKey: null });
    const segundo = await d.watch('v1b', SLUG, { participantId, attemptId: 'b'.repeat(32) }, { name: null, viewerKey: null });
    expect(peerIdOf(segundo)).toBe(peerIdOf(primeiro));
    expect(primeiro.closed()).toBe(true);
    expect(ofType(host, 'peer-left')).toEqual([]);
  });

  it('com aprovação ligada, quem tem o link PEDE para entrar — e só', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    const v = await d.watch('v', SLUG, undefined, { aprovar: false });
    expect(ofType(v, 'awaiting-approval')).toHaveLength(1);
    expect(ofType(v, 'watching')).toEqual([]);
    expect(ofType(host, 'join-request').map((m) => m.name)).toEqual(['v']);
  });

  it('dono que volta com a sala aberta deixa entrar quem esperava', async () => {
    const d = criar();
    await d.host('h1', SLUG, OWNER, { approval: true });
    const v = await d.watch('ana', SLUG, undefined, { aprovar: false });
    d.disconnect('h1');
    d.hibernar?.();
    const h2 = await d.host('h2', SLUG, OWNER);
    expect(ofType(v, 'watching')[0]?.hostId).toBe(peerIdOf(h2));
    expect(ofType(h2, 'join-request')).toEqual([]);
  });

  it('sem transmissão, qualquer nome dá NOT_HOSTING', async () => {
    const d = criar();
    expect(errorOf(await d.watch('v1', SLUG))).toBe('NOT_HOSTING');
  });

  it('cliente v1 (sem protocolo) é recusado com código que ele entende', async () => {
    const d = criar();
    const hostAntigo = await d.host('h1', SLUG, OWNER, { protocol: null });
    expect(errorOf(hostAntigo)).toBe('BAD_MESSAGE');
    await d.host('h2', SLUG, OWNER);
    const antigo = await d.watch('v', SLUG, undefined, { protocol: null });
    expect(errorOf(antigo)).toBe('BAD_MESSAGE');
  });

  it('versão diferente recebe PROTOCOL_MISMATCH', async () => {
    const d = criar();
    const futuro = await d.host('h', SLUG, OWNER, { protocol: PROTOCOL_VERSION + 1 });
    expect(errorOf(futuro)).toBe('PROTOCOL_MISMATCH');
  });

  it('aba aberta na v3 (com convite) recebe PROTOCOL_MISMATCH: recarregar', async () => {
    const d = criar();
    const velho = await d.host('h', SLUG, OWNER, { protocol: 3 });
    expect(errorOf(velho)).toBe('PROTOCOL_MISMATCH');
  });

  it('espectador v2 (sem aprovação) recebe PROTOCOL_MISMATCH, nunca entra direto', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const antigo = await d.watch('v', SLUG, undefined, { protocol: 2, name: null, viewerKey: null });
    expect(errorOf(antigo)).toBe('PROTOCOL_MISMATCH');
    expect(ofType(host, 'join-request')).toEqual([]);
    expect(ofType(host, 'peer-joined')).toEqual([]);
  });

  it('`set-invite` não existe mais: mensagem desconhecida', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    await d.send('h', { type: 'set-invite', invite: 'd'.repeat(22) });
    expect(errorOf(host)).toBe('BAD_MESSAGE');
  });

  it('espectador não remove ninguém', async () => {
    const d = criar();
    await d.host('h', SLUG, OWNER);
    const v1 = await d.watch('v1', SLUG);
    const v2 = await d.watch('v2', SLUG);
    await d.send('v1', { type: 'remove-viewers' });
    expect(errorOf(v1)).toBe('BAD_MESSAGE');
    expect(v2.closed()).toBe(false);
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
});

it('Worker: pedido ainda sem resposta não gasta credencial TURN', async () => {
  const pedidos: string[] = [];
  const d = makeWorkerDriver(async (peerId) => {
    pedidos.push(peerId);
    return { servers: [{ urls: ['stun:test'] }], relayStatus: 'not-configured' };
  });
  await d.host('h', SLUG, OWNER, { approval: true });
  const antes = pedidos.length;
  await d.watch('v', SLUG, undefined, { aprovar: false });
  expect(pedidos.length).toBe(antes);
});

describe.each(implementacoes)('aprovação manual (ADR 0025) — %s', (_nome, criar) => {
  const esperar = { aprovar: false } as const;

  it('o pedido chega ao transmissor antes de vaga e de credencial', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    const v = await d.watch('ana', SLUG, undefined, esperar);
    expect(ofType(v, 'awaiting-approval')).toHaveLength(1);
    expect(ofType(v, 'watching')).toEqual([]);
    expect(ofType(host, 'peer-joined')).toEqual([]);
    const [pedido] = ofType(host, 'join-request');
    expect(pedido?.name).toBe('ana');
    // O transmissor recebe o hash da chave, nunca a chave.
    expect(pedido?.fingerprint).not.toBe(chaveDe('ana'));
    expect(JSON.stringify(host.received())).not.toContain(chaveDe('ana'));
    expect(v.closed()).toBe(false);
  });

  it('aceitar dá vaga, credencial e avisa o transmissor', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    const v = await d.watch('ana', SLUG, undefined, esperar);
    const peerId = ofType(host, 'join-request')[0]!.peerId;
    await d.send('h', { type: 'admit', peerId });
    expect(ofType(v, 'watching')[0]?.peerId).toBe(peerId);
    expect(ofType(host, 'peer-joined')).toEqual([
      { type: 'peer-joined', peerId, name: 'ana', fingerprint: ofType(host, 'join-request')[0]!.fingerprint },
    ]);
  });

  it('recusar fecha com DENIED e não dá vaga', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    const v = await d.watch('ana', SLUG, undefined, esperar);
    await d.send('h', { type: 'deny', peerId: ofType(host, 'join-request')[0]!.peerId });
    expect(errorOf(v)).toBe('DENIED');
    expect(v.closed()).toBe(true);
    expect(ofType(v, 'watching')).toEqual([]);
    expect(ofType(host, 'peer-joined')).toEqual([]);
    expect(ofType(host, 'join-cancelled')).toEqual([]);
  });

  it('quem desiste da espera some da fila do transmissor', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    await d.watch('ana', SLUG, undefined, esperar);
    const peerId = ofType(host, 'join-request')[0]!.peerId;
    d.disconnect('ana');
    expect(ofType(host, 'join-cancelled')).toEqual([{ type: 'join-cancelled', peerId }]);
    // Aceitar depois é silêncio: não há mais ninguém.
    await d.send('h', { type: 'admit', peerId });
    expect(ofType(host, 'peer-joined')).toEqual([]);
    expect(host.closed()).toBe(false);
  });

  it('sem apelido ou sem chave não há pedido', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    expect(errorOf(await d.watch('a', SLUG, undefined, { ...esperar, name: null }))).toBe('BAD_MESSAGE');
    expect(errorOf(await d.watch('b', SLUG, undefined, { ...esperar, viewerKey: null }))).toBe('BAD_MESSAGE');
    expect(errorOf(await d.watch('c', SLUG, undefined, { ...esperar, name: 'a\u0007b' }))).toBe('BAD_MESSAGE');
    expect(errorOf(await d.watch('d', SLUG, undefined, { ...esperar, name: 'x'.repeat(25) }))).toBe('BAD_MESSAGE');
    expect(ofType(host, 'join-request')).toEqual([]);
  });

  it('só o transmissor responde a pedido', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    const dentro = await d.watch('dentro', SLUG);
    const esperando = await d.watch('ana', SLUG, undefined, esperar);
    const peerId = ofType(host, 'join-request').find((m) => m.name === 'ana')!.peerId;
    await d.send('dentro', { type: 'admit', peerId });
    expect(errorOf(dentro)).toBe('BAD_MESSAGE');
    expect(ofType(esperando, 'watching')).toEqual([]);
  });

  it('a mesma chave gera a mesma impressão; outra chave, outra', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    await d.watch('ana', SLUG, undefined, esperar);
    await d.watch('ana-de-novo', SLUG, undefined, { ...esperar, viewerKey: chaveDe('ana') });
    await d.watch('bia', SLUG, undefined, esperar);
    const [a, a2, b] = ofType(host, 'join-request').map((m) => m.fingerprint);
    expect(a).toBe(a2);
    expect(b).not.toBe(a);
  });

  it('a fila tem teto: pedido excedente é recusado sem chegar ao transmissor', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    const teto = DEFAULT_LIMITS.maxPending;
    for (let i = 0; i < teto; i += 1) await d.watch(`p${i}`, SLUG, undefined, esperar);
    expect(errorOf(await d.watch(`p${teto}`, SLUG, undefined, esperar))).toBe('RATE_LIMITED');
    expect(ofType(host, 'join-request')).toHaveLength(teto);
  });

  it('canal cheio no momento de aceitar: CHANNEL_FULL e o pedido sai da fila', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    const v = await d.watch('ana', SLUG, undefined, esperar);
    const peerId = ofType(host, 'join-request')[0]!.peerId;
    for (const id of ['x', 'y', 'z']) await d.watch(id, SLUG);
    await d.send('h', { type: 'admit', peerId });
    expect(errorOf(v)).toBe('CHANNEL_FULL');
    expect(ofType(host, 'join-cancelled')).toEqual([{ type: 'join-cancelled', peerId }]);
  });

  it('transmissor que reconecta recebe de novo os pedidos em espera', async () => {
    const d = criar();
    await d.host('h1', SLUG, OWNER, { approval: true });
    const v = await d.watch('ana', SLUG, undefined, esperar);
    d.disconnect('h1');
    d.hibernar?.();
    const h2 = await d.host('h2', SLUG, OWNER, { approval: true });
    const [pedido] = ofType(h2, 'join-request');
    expect(pedido?.name).toBe('ana');
    await d.send('h2', { type: 'admit', peerId: pedido!.peerId });
    expect(ofType(v, 'watching')[0]?.hostId).toBe(peerIdOf(h2));
  });

  it('transmissor que ENCERRA derruba quem esperava com NOT_HOSTING', async () => {
    const d = criar();
    await d.host('h', SLUG, OWNER, { approval: true });
    const v = await d.watch('ana', SLUG, undefined, esperar);
    await d.leave('h');
    d.disconnect('h');
    expect(errorOf(v)).toBe('NOT_HOSTING');
    expect(v.closed()).toBe(true);
  });

  it('o pedido sobrevive à hibernação e é aceito depois dela', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    const v = await d.watch('ana', SLUG, undefined, esperar);
    d.hibernar?.();
    await d.send('h', { type: 'admit', peerId: ofType(host, 'join-request')[0]!.peerId });
    expect(ofType(v, 'watching')).toHaveLength(1);
  });

  it('retomar a vaga exige a MESMA chave: participante sem ela vira pedido', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER, { approval: true });
    const participantId = 'p'.repeat(32);
    const dentro = await d.watch('ana', SLUG, { participantId, attemptId: 'a'.repeat(32) });
    const impostor = await d.watch('eva', SLUG, { participantId, attemptId: 'b'.repeat(32) }, esperar);
    expect(ofType(impostor, 'awaiting-approval')).toHaveLength(1);
    expect(ofType(impostor, 'watching')).toEqual([]);
    expect(dentro.closed()).toBe(false);
    expect(ofType(host, 'join-request').map((m) => m.name)).toEqual(['ana', 'eva']);
  });
});
