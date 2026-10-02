import { webcrypto } from 'node:crypto';
import { HELLO_TIMEOUT_MS, MAX_FRAME_BYTES } from '@tela/shared';
import { describe, expect, it } from 'vitest';
import { OUTRO, OWNER, SLUG, saudar } from './conformance.js';
import type { IceProvisionResult } from './ice-provision.js';
import { FakeDurableContext, FakeHibernatableSocket } from './testing-worker-driver.js';
import { ChannelRoom, type Env, type WebCryptoLike, makeChannelDeps } from './worker.js';

/**
 * O que só o Durable Object tem: hibernação, alarme e `await` no meio da
 * saudação. A suíte de conformidade cobre o comportamento comum; isto cobre
 * as defesas que o Node não precisa porque é síncrono e tem `setTimeout`.
 */
function sala(ice?: (peerId: string) => Promise<IceProvisionResult>) {
  const env: Env = { CHANNELS: null as never, MAX_PEERS: '3' };
  const pedidos: string[] = [];
  const base = makeChannelDeps(env, webcrypto as unknown as WebCryptoLike);
  const deps = {
    ...base,
    iceServersFor: async (peerId: string) => {
      pedidos.push(peerId);
      return ice === undefined ? base.iceServersFor(peerId) : ice(peerId);
    },
  };
  const ctx = new FakeDurableContext();
  const room = new ChannelRoom(ctx, deps);
  const abrir = () => {
    const socket = new FakeHibernatableSocket();
    socket.aoFechar = () => room.handleClose(socket);
    room.accept(socket);
    return socket;
  };
  const mandar = (socket: FakeHibernatableSocket, msg: unknown) =>
    room.handleMessage(socket, SLUG, typeof msg === 'string' ? msg : JSON.stringify(msg));
  return { ctx, room, abrir, mandar, pedidos };
}

describe('Worker endurecido (TELA-019)', () => {
  it('teto de frame em BYTES: texto multibyte curto em unidades mas grande em bytes cai', async () => {
    const s = sala();
    const socket = s.abrir();
    const euros = '€'.repeat(Math.ceil(MAX_FRAME_BYTES / 3) + 10); // < 64k unidades, > 64 KB
    expect(euros.length).toBeLessThan(MAX_FRAME_BYTES);
    await s.mandar(socket, JSON.stringify({ type: 'signal', payload: euros }));
    expect(socket.sent.at(-1)).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    expect(socket.closed).toBe(true);
  });

  it('socket que abre e não se apresenta expira pelo ALARME, não por timer de instância', async () => {
    const s = sala();
    const calado = s.abrir();
    const falante = s.abrir();
    await s.mandar(falante, saudar({ type: 'host', slug: SLUG, ownerToken: OWNER }));
    expect(s.ctx.alarme).not.toBeNull();

    // Hibernação no meio: o objeto é outro, o attachment é o mesmo.
    const reconstruido = new ChannelRoom(s.ctx, makeChannelDeps(
      { CHANNELS: null as never, MAX_PEERS: '3' }, webcrypto as unknown as WebCryptoLike,
    ));
    await reconstruido.expirarPendentes(Date.now() + HELLO_TIMEOUT_MS + 1);
    expect(calado.sent.at(-1)).toEqual({ type: 'error', code: 'HELLO_TIMEOUT' });
    expect(calado.closed).toBe(true);
    expect(falante.closed).toBe(false);
  });

  it('antes do prazo, o alarme só reagenda', async () => {
    const s = sala();
    const calado = s.abrir();
    await s.room.expirarPendentes(Date.now());
    expect(calado.closed).toBe(false);
    expect(s.ctx.alarme).not.toBeNull();
  });

  it('segunda saudação no mesmo socket durante o await não dispara outro claim nem outro TURN', async () => {
    let soltar!: () => void;
    const portao = new Promise<void>((r) => { soltar = r; });
    const s = sala(async () => {
      await portao;
      return { servers: [{ urls: ['stun:test'] }], relayStatus: 'not-configured' };
    });
    const socket = s.abrir();
    const primeiro = s.mandar(socket, saudar({ type: 'host', slug: SLUG, ownerToken: OWNER }));
    await new Promise((r) => setTimeout(r, 10));
    await s.mandar(socket, saudar({ type: 'host', slug: SLUG, ownerToken: OWNER }));
    soltar();
    await primeiro;
    expect(s.pedidos).toHaveLength(1);
    expect(socket.closed).toBe(true);
  });

  it('dono errado sai antes da emissão TURN', async () => {
    const s = sala();
    await s.mandar(s.abrir(), saudar({ type: 'host', slug: SLUG, ownerToken: OWNER }));
    const antes = s.pedidos.length;
    const intruso = s.abrir();
    await s.mandar(intruso, saudar({ type: 'host', slug: SLUG, ownerToken: OUTRO }));
    expect(intruso.sent.at(-1)).toEqual({ type: 'error', code: 'SLUG_TAKEN' });
    expect(s.pedidos.length).toBe(antes);
  });

  it('depois da hibernação, o pedido ainda chega ao transmissor', async () => {
    const s = sala();
    await s.mandar(s.abrir(), saudar({ type: 'host', slug: SLUG, ownerToken: OWNER }, { approval: true }));
    const depois = new ChannelRoom(s.ctx, makeChannelDeps(
      { CHANNELS: null as never, MAX_PEERS: '3' }, webcrypto as unknown as WebCryptoLike,
    ));
    const v = new FakeHibernatableSocket();
    depois.accept(v);
    await depois.handleMessage(v, SLUG, JSON.stringify(saudar({ type: 'watch', slug: SLUG })));
    // A entrada é do dono (ADR 0025): o pedido chega, sem convite (ADR 0026).
    expect(v.sent[0]?.type).toBe('awaiting-approval');
  });
});

/**
 * Índice de attachments (ADR 0031, C2): o relay deixou de varrer a sala.
 * O índice é estado derivado — estes testes provam as duas metades: que ele
 * evita as desserializações e que ele nunca é a fonte da verdade.
 */
class SocketContado extends FakeHibernatableSocket {
  leituras = 0;
  override deserializeAttachment(): unknown {
    this.leituras += 1;
    return super.deserializeAttachment();
  }
}

function salaGrande(maxPeers: number) {
  const env: Env = { CHANNELS: null as never, MAX_PEERS: String(maxPeers) };
  const deps = makeChannelDeps(env, webcrypto as unknown as WebCryptoLike);
  const ctx = new FakeDurableContext();
  const ref = { room: new ChannelRoom(ctx, deps) };
  const todos: SocketContado[] = [];
  const abrir = () => {
    const socket = new SocketContado();
    socket.aoFechar = () => ref.room.handleClose(socket);
    ref.room.accept(socket);
    todos.push(socket);
    return socket;
  };
  const mandar = (socket: FakeHibernatableSocket, msg: unknown) =>
    ref.room.handleMessage(socket, SLUG, JSON.stringify(msg));
  /** O objeto é despejado e reconstruído sobre os mesmos sockets. */
  const hibernar = () => { ref.room = new ChannelRoom(ctx, deps); };
  const peerIdDe = (socket: FakeHibernatableSocket): string => {
    const w = socket.sent.find((m) => m.type === 'watching');
    if (w?.type !== 'watching') throw new Error('sem watching');
    return w.peerId;
  };
  const entrar = async (n: number) => {
    const out: SocketContado[] = [];
    for (let i = 0; i < n; i += 1) {
      const v = abrir();
      await mandar(v, saudar({ type: 'watch', slug: SLUG }, undefined, `viewer-${i}`));
      out.push(v);
    }
    return out;
  };
  const host = async () => {
    const h = abrir();
    // Sem `capacidade` o teto seria o de quem codifica por espectador (5).
    await mandar(h, saudar({ type: 'host', slug: SLUG, ownerToken: OWNER, capacidade: maxPeers }));
    return h;
  };
  return { ctx, ref, abrir, mandar, hibernar, peerIdDe, entrar, host, todos };
}

const sinaisRecebidos = (s: FakeHibernatableSocket) => s.sent.filter((m) => m.type === 'signal');

describe('índice de attachments (C2)', () => {
  it('entrada em massa de 50: cada sinal toca O(1) attachments, não O(N)', async () => {
    const s = salaGrande(50);
    const h = await s.host();
    const viewers = await s.entrar(50);
    expect(viewers.every((v) => v.sent.some((m) => m.type === 'watching'))).toBe(true);

    for (const v of s.todos) v.leituras = 0;
    for (const v of viewers) await s.mandar(h, { type: 'signal', to: s.peerIdDe(v), payload: 'oferta' });
    for (const v of viewers) await s.mandar(v, { type: 'signal', payload: 'resposta' });

    for (const v of viewers) expect(sinaisRecebidos(v)).toHaveLength(1);
    expect(sinaisRecebidos(h)).toHaveLength(50);
    // 100 sinais; antes eram ~2(N+1) = 102 leituras por sinal em todos os sockets somados.
    const leituras = s.todos.reduce((soma, v) => soma + v.leituras, 0);
    expect(leituras).toBeLessThanOrEqual(0);
  });

  it('depois da hibernação o índice nasce vazio e é reconstruído uma única vez', async () => {
    const s = salaGrande(10);
    const h = await s.host();
    const viewers = await s.entrar(10);
    s.hibernar();
    for (const v of s.todos) v.leituras = 0;

    await s.mandar(h, { type: 'signal', to: s.peerIdDe(viewers[3]!), payload: 'a' });
    expect(sinaisRecebidos(viewers[3]!)).toHaveLength(1);
    const primeira = s.todos.reduce((soma, v) => soma + v.leituras, 0);
    // Uma varredura (11 sockets) mais a leitura do rate limit do próprio remetente.
    expect(primeira).toBeLessThanOrEqual(11);

    for (const v of s.todos) v.leituras = 0;
    for (const v of viewers) await s.mandar(v, { type: 'signal', payload: 'b' });
    expect(sinaisRecebidos(h)).toHaveLength(10);
    expect(s.todos.reduce((soma, v) => soma + v.leituras, 0)).toBe(0);
  });

  it('espectador que sai some do índice: sinal para ele é descartado, o resto segue', async () => {
    const s = salaGrande(5);
    const h = await s.host();
    const [a, b] = await s.entrar(2) as [SocketContado, SocketContado];
    const idA = s.peerIdDe(a);
    await s.mandar(a, { type: 'leave' });
    expect(a.closed).toBe(true);

    await s.mandar(h, { type: 'signal', to: idA, payload: 'x' });
    expect(sinaisRecebidos(a)).toHaveLength(0);
    await s.mandar(h, { type: 'signal', to: s.peerIdDe(b), payload: 'y' });
    expect(sinaisRecebidos(b)).toHaveLength(1);
    // A hibernação não ressuscita quem saiu.
    s.hibernar();
    await s.mandar(h, { type: 'signal', to: idA, payload: 'z' });
    expect(sinaisRecebidos(a)).toHaveLength(0);
  });

  it('sinal para peer desconhecido é silêncio, como antes: sem erro e sem fechar', async () => {
    const s = salaGrande(5);
    const h = await s.host();
    const [a] = await s.entrar(1) as [SocketContado];
    const antes = h.sent.length;
    await s.mandar(h, { type: 'signal', to: 'v-inexistente', payload: 'x' });
    await s.mandar(h, { type: 'signal', payload: 'sem destino' });
    expect(h.sent.length).toBe(antes);
    expect(h.closed).toBe(false);
    expect(sinaisRecebidos(a)).toHaveLength(0);
  });

  it('host substituído: o índice passa a rotear para o host novo', async () => {
    const s = salaGrande(5);
    const velho = await s.host();
    const [a] = await s.entrar(1) as [SocketContado];
    const novo = await s.host();
    expect(velho.closed).toBe(true);
    await s.mandar(a, { type: 'signal', payload: 'p' });
    expect(sinaisRecebidos(novo)).toHaveLength(1);
    expect(sinaisRecebidos(velho)).toHaveLength(0);
    s.hibernar();
    await s.mandar(a, { type: 'signal', payload: 'q' });
    expect(sinaisRecebidos(novo)).toHaveLength(2);
  });

  it('espectador removido pelo host não recebe mais sinal, nem depois de hibernar', async () => {
    const s = salaGrande(5);
    const h = await s.host();
    const [a] = await s.entrar(1) as [SocketContado];
    const id = s.peerIdDe(a);
    await s.mandar(h, { type: 'remove-viewers', peerId: id });
    s.hibernar();
    await s.mandar(h, { type: 'signal', to: id, payload: 'x' });
    expect(sinaisRecebidos(a)).toHaveLength(0);
  });
});
