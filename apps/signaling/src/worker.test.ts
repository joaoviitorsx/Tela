import { webcrypto } from 'node:crypto';
import { HELLO_TIMEOUT_MS, MAX_FRAME_BYTES } from '@tela/shared';
import { describe, expect, it } from 'vitest';
import { CONVITE, OUTRO, OWNER, SLUG, saudar } from './conformance.js';
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

  it('o convite sobrevive à hibernação: o errado segue barrado, o certo entra', async () => {
    const s = sala();
    await s.mandar(s.abrir(), saudar({ type: 'host', slug: SLUG, ownerToken: OWNER }));
    const depois = new ChannelRoom(s.ctx, makeChannelDeps(
      { CHANNELS: null as never, MAX_PEERS: '3' }, webcrypto as unknown as WebCryptoLike,
    ));
    const errado = new FakeHibernatableSocket();
    depois.accept(errado);
    await depois.handleMessage(errado, SLUG, JSON.stringify(saudar(
      { type: 'watch', slug: SLUG }, { invite: 'x'.repeat(22) },
    )));
    expect(errado.sent.at(-1)).toEqual({ type: 'error', code: 'INVITE_INVALID' });
    const certo = new FakeHibernatableSocket();
    depois.accept(certo);
    await depois.handleMessage(certo, SLUG, JSON.stringify(saudar({ type: 'watch', slug: SLUG }, { invite: CONVITE })));
    // Convite certo: o pedido chega ao transmissor (a entrada é dele, ADR 0025).
    expect(certo.sent[0]?.type).toBe('awaiting-approval');
  });
});
