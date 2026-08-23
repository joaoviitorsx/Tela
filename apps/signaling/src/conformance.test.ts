import { describe, expect, it } from 'vitest';
import { makeNodeDriver } from './testing-node-driver.js';
import { makeWorkerDriver } from './testing-worker-driver.js';
import {
  OUTRO,
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

  it('saída do transmissor AVISA os espectadores antes de derrubar', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    const viewer = await d.watch('v', SLUG);
    d.disconnect('h');

    // Socket fechado em silêncio não distingue "o transmissor saiu" de "o
    // servidor caiu" — e o espectador ficava "assistindo" vídeo congelado.
    expect(ofType(viewer, 'peer-left')).toEqual([
      { type: 'peer-left', peerId: peerIdOf(host) },
    ]);
    expect(viewer.closed()).toBe(true);
  });

  it('destino inexistente é ignorado, não derruba a conexão', async () => {
    const d = criar();
    const host = await d.host('h', SLUG, OWNER);
    // Espectador que saiu no exato momento em que a oferta ia sair. Acontece.
    await d.signal('h', { description: { type: 'offer', sdp: 'v=0' } }, 'v_fantasma');
    expect(host.closed()).toBe(false);
    expect(errorOf(host)).toBeUndefined();
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
