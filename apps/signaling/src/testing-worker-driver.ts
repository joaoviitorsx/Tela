import { webcrypto } from 'node:crypto';
import type { ServerMessage } from '@tela/shared';
import { type ConformanceClient, type ConformanceDriver, type OpcoesDoDriver, TETO_DE_TESTE, saudar } from './conformance.js';
import type { IceProvisionResult } from './ice-provision.js';
import {
  ChannelRoom,
  type DurableContext,
  IpLimiter,
  type Env,
  type HibernatableSocket,
  type WebCryptoLike,
  makeChannelDeps,
} from './worker.js';

/**
 * Socket com a semântica do runtime da Cloudflare: o que sobrevive à
 * hibernação é só o que foi para `serializeAttachment`.
 */
export class FakeHibernatableSocket implements HibernatableSocket {
  readonly sent: ServerMessage[] = [];
  closed = false;
  private attachment: unknown = null;

  /**
   * O runtime chama `webSocketClose` quando o socket fecha — inclusive quando
   * quem fechou foi o próprio servidor.
   *
   * Sem isto, todo fechamento iniciado pelo servidor era invisível para a
   * suíte de conformidade: substituir um host "passava" no teste enquanto na
   * produção derrubava todos os espectadores.
   */
  aoFechar: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.aoFechar?.();
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

export class FakeDurableContext implements DurableContext {
  private readonly sockets: FakeHibernatableSocket[] = [];
  private readonly dados = new Map<string, unknown>();

  acceptWebSocket(socket: HibernatableSocket): void {
    this.sockets.push(socket as FakeHibernatableSocket);
  }
  /** O runtime não devolve sockets fechados. */
  getWebSockets(): HibernatableSocket[] {
    return this.sockets.filter((s) => !s.closed);
  }

  /**
   * Serializa de verdade, em vez de só chamar a função.
   *
   * Um fake que apenas executasse o callback aprovaria o `check-then-act` que
   * esta primitiva existe para impedir — a suíte passaria e o defeito seguiria
   * vivo no runtime.
   */
  private fila: Promise<unknown> = Promise.resolve();

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const resultado = this.fila.then(fn, fn);
    this.fila = resultado.then(
      () => undefined,
      () => undefined,
    );
    return resultado;
  }

  readonly storage = {
    get: async <T>(key: string): Promise<T | undefined> => this.dados.get(key) as T | undefined,
    put: async <T>(key: string, value: T): Promise<void> => {
      // Passa por JSON como o runtime faz: nada de vivo atravessa.
      this.dados.set(key, JSON.parse(JSON.stringify(value)));
    },
    delete: async (key: string): Promise<boolean> => this.dados.delete(key),
    getAlarm: async (): Promise<number | null> => this.alarme,
    setAlarm: async (quando: number): Promise<void> => {
      this.alarme = quando;
    },
  };

  /** O alarme agendado, para o teste afirmar. */
  alarme: number | null = null;
}

/**
 * Driver de conformidade sobre o Durable Object.
 *
 * Um DO por slug, como em produção: `rooms` é o `idFromName` do teste.
 */
export function makeWorkerDriver(
  iceServersFor?: (peerId: string) => Promise<IceProvisionResult>,
  opcoes: OpcoesDoDriver = {},
): ConformanceDriver {
  const env: Env = { CHANNELS: null as never, MAX_PEERS: String(opcoes.maxPeers ?? TETO_DE_TESTE) };
  /*
    Um contador por IP, com a MESMA classe do Durable Object de produção e um
    contexto de storage falso por IP: o que roda aqui é o `IpLimiter` de
    verdade, não um Map que concordaria com qualquer implementação.
  */
  const limitadores = new Map<string, IpLimiter>();
  const ipGate = async (ip: string, chave: string, limite: number, janelaMs: number) => {
    let l = limitadores.get(ip);
    if (l === undefined) {
      l = new IpLimiter(new FakeDurableContext());
      limitadores.set(ip, l);
    }
    return await l.take(chave, limite, janelaMs);
  };
  const base = makeChannelDeps(env, webcrypto as unknown as WebCryptoLike);
  const deps = { ...base, ipGate,
    limits: { ...base.limits, ...opcoes.limites },
    ...(iceServersFor === undefined ? {} : { iceServersFor }) };

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

  /**
   * Simula a hibernação: o objeto é despejado da memória e reconstruído sobre
   * o MESMO contexto, com os mesmos sockets abertos.
   *
   * É o único jeito de exercitar o motivo de existir esta segunda
   * implementação. Sem isto, o caminho que a plataforma mais usa nunca era
   * testado — e foi exatamente ali que um estranho conseguia assumir um canal
   * ao vivo.
   */
  function hibernar(): void {
    for (const [slug, atual] of rooms) {
      rooms.set(slug, { room: new ChannelRoom(atual.ctx, deps), ctx: atual.ctx });
    }
  }

  const client = (id: string): ConformanceClient => ({
    id,
    received: () => sockets.get(id)?.sent ?? [],
    last: () => sockets.get(id)?.sent.at(-1),
    closed: () => sockets.get(id)?.closed ?? false,
  });

  async function open(id: string, slug: string, message: unknown, ip?: string): Promise<ConformanceClient> {
    const socket = new FakeHibernatableSocket();
    sockets.set(id, socket);
    slugOf.set(id, slug);

    const alvo = roomFor(slug);
    alvo.room.accept(socket, ip);
    // O runtime avisa o objeto quando o socket fecha, inclusive quando foi o
    // próprio servidor que fechou.
    socket.aoFechar = () => roomFor(slug).room.handleClose(socket);
    await alvo.room.handleMessage(socket, slug, JSON.stringify(message));
    return client(id);
  }

  return {
    async host(id, slug, ownerToken, saudacao) {
      return await open(id, slug, saudar({ type: 'host', slug, ownerToken }, saudacao), saudacao?.ip);
    },
    async watch(id, slug, identity, saudacao) {
      return await open(id, slug, saudar({ type: 'watch', slug, ...identity }, saudacao, id), saudacao?.ip);
    },
    async send(id, message) {
      const socket = sockets.get(id);
      const slug = slugOf.get(id);
      if (socket === undefined || slug === undefined) return;
      await roomFor(slug).room.handleMessage(socket, slug, JSON.stringify(message));
    },
    async refreshIce(id, requestId) {
      const socket = sockets.get(id);
      const slug = slugOf.get(id);
      if (socket === undefined || slug === undefined) return;
      await roomFor(slug).room.handleMessage(socket, slug, JSON.stringify({ type: 'refresh-ice', requestId }));
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
    async leave(id) {
      const socket = sockets.get(id);
      const slug = slugOf.get(id);
      if (socket === undefined || slug === undefined) return;
      await roomFor(slug).room.handleMessage(socket, slug, JSON.stringify({ type: 'leave' }));
    },
    disconnect(id) {
      const socket = sockets.get(id);
      if (socket === undefined) return;
      socket.close();
    },
    hibernar,
  };
}
