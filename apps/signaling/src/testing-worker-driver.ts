import { webcrypto } from 'node:crypto';
import type { ServerMessage } from '@tela/shared';
import type { ConformanceClient, ConformanceDriver } from './conformance.js';
import {
  ChannelRoom,
  type DurableContext,
  type Env,
  type HibernatableSocket,
  type WebCryptoLike,
  makeChannelDeps,
} from './worker.js';

/**
 * Socket com a semântica do runtime da Cloudflare: o que sobrevive à
 * hibernação é só o que foi para `serializeAttachment`.
 */
class FakeHibernatableSocket implements HibernatableSocket {
  readonly sent: ServerMessage[] = [];
  closed = false;
  private attachment: unknown = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.closed = true;
  }
  serializeAttachment(value: unknown): void {
    // O runtime real serializa: passar por JSON garante que nada de vivo
    // (função, referência a closure) atravesse por acidente no teste.
    this.attachment = JSON.parse(JSON.stringify(value));
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

class FakeDurableContext implements DurableContext {
  private readonly sockets: FakeHibernatableSocket[] = [];

  acceptWebSocket(socket: HibernatableSocket): void {
    this.sockets.push(socket as FakeHibernatableSocket);
  }
  /** O runtime não devolve sockets fechados. */
  getWebSockets(): HibernatableSocket[] {
    return this.sockets.filter((s) => !s.closed);
  }
}

/**
 * Driver de conformidade sobre o Durable Object.
 *
 * Um DO por slug, como em produção: `rooms` é o `idFromName` do teste.
 */
export function makeWorkerDriver(): ConformanceDriver {
  const env: Env = { CHANNELS: null as never, MAX_PEERS: '3' };
  const deps = makeChannelDeps(env, webcrypto as unknown as WebCryptoLike);

  const rooms = new Map<string, { room: ChannelRoom; ctx: FakeDurableContext }>();
  const sockets = new Map<string, FakeHibernatableSocket>();
  const slugOf = new Map<string, string>();

  function roomFor(slug: string) {
    const existing = rooms.get(slug);
    if (existing !== undefined) return existing;
    const ctx = new FakeDurableContext();
    const created = { room: new ChannelRoom(ctx, deps), ctx };
    rooms.set(slug, created);
    return created;
  }

  const client = (id: string): ConformanceClient => ({
    id,
    received: () => sockets.get(id)?.sent ?? [],
    last: () => sockets.get(id)?.sent.at(-1),
    closed: () => sockets.get(id)?.closed ?? false,
  });

  async function open(id: string, slug: string, message: unknown): Promise<ConformanceClient> {
    const socket = new FakeHibernatableSocket();
    sockets.set(id, socket);
    slugOf.set(id, slug);

    const { room } = roomFor(slug);
    room.accept(socket);
    await room.handleMessage(socket, slug, JSON.stringify(message));
    return client(id);
  }

  return {
    async host(id, slug, ownerToken) {
      return await open(id, slug, { type: 'host', slug, ownerToken });
    },
    async watch(id, slug) {
      return await open(id, slug, { type: 'watch', slug });
    },
    async signal(id, payload, to) {
      const socket = sockets.get(id);
      const slug = slugOf.get(id);
      if (socket === undefined || slug === undefined) return;
      await roomFor(slug).room.handleMessage(
        socket,
        slug,
        JSON.stringify(to === undefined ? { type: 'signal', payload } : { type: 'signal', to, payload }),
      );
    },
    disconnect(id) {
      const socket = sockets.get(id);
      const slug = slugOf.get(id);
      if (socket === undefined || slug === undefined) return;
      const { room } = roomFor(slug);
      room.handleClose(socket);
      socket.closed = true;
    },
  };
}
