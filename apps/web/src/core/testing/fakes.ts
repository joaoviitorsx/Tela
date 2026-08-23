import type { Connection } from '@tela/shared';
import type { ApiResult, ClaimOutcome, TelaApi } from '../api/client.js';
import { Emitter } from '../emitter.js';
import type { AudioCapture } from '../ports/audio-capture.js';
import type {
  PublishRequest,
  PublisherEvents,
  PublisherTransport,
  TransportFactory,
  TransportStats,
  ViewerEvents,
  ViewerTransport,
} from '../ports/media-transport.js';
import type { Cancel, Scheduler } from '../ports/scheduler.js';
import type { ScreenCapture } from '../ports/screen-capture.js';
import type { Storage } from '../ports/storage.js';
import type { Random } from '../ports/random.js';

/**
 * Fakes que fazem os testes de sessão rodarem sem browser, sem servidor e sem
 * rede — em milissegundos. É o retorno concreto da regra R1: se a lógica de
 * mídia estivesse dentro de `useEffect`, nada disto seria testável.
 */

export class FakeScheduler implements Scheduler {
  private time = 0;
  private seq = 0;
  private readonly tasks = new Map<
    number,
    { at: number; every: number | null; run: () => void }
  >();

  every(intervalMs: number, task: () => void): Cancel {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.time + intervalMs, every: intervalMs, run: task });
    return () => this.tasks.delete(id);
  }

  after(delayMs: number, task: () => void): Cancel {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.time + delayMs, every: null, run: task });
    return () => this.tasks.delete(id);
  }

  now(): number {
    return this.time;
  }

  /** Avança o relógio disparando tudo que vencer no caminho. */
  advance(ms: number): void {
    const target = this.time + ms;
    let guard = 0;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || (guard += 1) > 1_000) break;

      const [id, task] = due;
      this.time = task.at;
      if (task.every === null) this.tasks.delete(id);
      else task.at = this.time + task.every;
      task.run();
    }
    this.time = target;
  }

  get pending(): number {
    return this.tasks.size;
  }
}

export function fakeTrack(kind: 'video' | 'audio'): MediaStreamTrack {
  const listeners = new Map<string, Set<() => void>>();
  const track = {
    kind,
    id: `${kind}-fake`,
    contentHint: '',
    readyState: 'live' as MediaStreamTrackState,
    stopped: false,
    stop() {
      track.stopped = true;
      track.readyState = 'ended' as MediaStreamTrackState;
    },
    addEventListener(name: string, handler: () => void) {
      const set = listeners.get(name) ?? new Set();
      set.add(handler);
      listeners.set(name, set);
    },
    removeEventListener(name: string, handler: () => void) {
      listeners.get(name)?.delete(handler);
    },
    /** Só no fake: simula o usuário parando pelo controle nativo do browser. */
    fireEnded() {
      for (const handler of listeners.get('ended') ?? []) handler();
    },
  };
  return track as unknown as MediaStreamTrack & { stopped: boolean; fireEnded(): void };
}

export class FakeScreenCapture implements ScreenCapture {
  supported = true;
  denied = false;
  withAudio = false;
  lastRequest: unknown = null;
  readonly video = fakeTrack('video');
  readonly audio = fakeTrack('audio');

  isSupported(): boolean {
    return this.supported;
  }

  async request(options: unknown) {
    this.lastRequest = options;
    if (!this.supported) throw 'UNSUPPORTED';
    if (this.denied) throw 'DENIED';
    return { video: this.video, audio: this.withAudio ? this.audio : null };
  }
}

export class FakeAudioCapture implements AudioCapture {
  fails = false;
  async listMonitors() {
    return [{ id: 'monitor-1', label: 'TelaCapture Monitor' }];
  }
  async capture() {
    if (this.fails) throw new Error('sem permissão');
    return fakeTrack('audio');
  }
}

export class FakePublisherTransport implements PublisherTransport {
  private readonly emitter = new Emitter<PublisherEvents>();
  readonly published: PublishRequest[] = [];
  connected: Connection | null = null;
  closed = false;
  failOnConnect = false;
  stats: TransportStats | null = null;

  async connect(connection: Connection): Promise<void> {
    if (this.failOnConnect) throw new Error('connect failed');
    this.connected = connection;
  }
  async publish(request: PublishRequest): Promise<void> {
    this.published.push(request);
  }
  async readStats(): Promise<TransportStats | null> {
    return this.stats;
  }
  on<K extends keyof PublisherEvents>(event: K, handler: (p: PublisherEvents[K]) => void) {
    return this.emitter.on(event, handler);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  emit<K extends keyof PublisherEvents>(event: K, payload: PublisherEvents[K]): void {
    this.emitter.emit(event, payload);
  }
}

export class FakeViewerTransport implements ViewerTransport {
  private readonly emitter = new Emitter<ViewerEvents>();
  connected: Connection | null = null;
  closed = false;
  failOnConnect = false;
  stats: TransportStats | null = null;
  readonly stream = { getAudioTracks: () => [] } as unknown as MediaStream;

  async connect(connection: Connection, sink: (stream: MediaStream) => void): Promise<void> {
    if (this.failOnConnect) throw new Error('connect failed');
    this.connected = connection;
    sink(this.stream);
  }
  async readStats(): Promise<TransportStats | null> {
    return this.stats;
  }
  on<K extends keyof ViewerEvents>(event: K, handler: (p: ViewerEvents[K]) => void) {
    return this.emitter.on(event, handler);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  emit<K extends keyof ViewerEvents>(event: K, payload: ViewerEvents[K]): void {
    this.emitter.emit(event, payload);
  }
}

export function fakeTransports(
  publisher: PublisherTransport,
  viewer: ViewerTransport,
): TransportFactory {
  return {
    publisher: async () => publisher,
    viewer: async () => viewer,
  };
}

export const SFU_CONNECTION: Connection = {
  transport: 'sfu',
  token: 'jwt',
  wsUrl: 'wss://test/rtc',
  room: 'b_joao',
};

export const P2P_CONNECTION: Connection = {
  transport: 'p2p',
  ticket: 'a.b',
  signalUrl: 'ws://127.0.0.1:3333/api/signal',
  room: 'b_joao',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  maxViewers: 3,
};

export class FakeApi implements TelaApi {
  connection: Connection = SFU_CONNECTION;
  startError: ApiResult<never>['ok'] extends true ? never : null | 'OWNER_INVALID' | 'UPSTREAM_UNAVAILABLE' = null;
  pingError: null | 'NOT_LIVE' = null;
  joinError: null | 'NOT_LIVE' | 'VIEWER_LIMIT' = null;
  live = true;
  viewers = 0;
  readonly beacons: { slug: string; ownerToken: string }[] = [];
  pings = 0;

  async claim(slug: string): Promise<ClaimOutcome> {
    return { ok: true, value: { slug, shareUrl: `https://tela.gg/${slug}` } };
  }

  async startBroadcast(slug: string) {
    if (this.startError !== null) return { ok: false as const, error: this.startError };
    return {
      ok: true as const,
      value: { connection: this.connection, shareUrl: `https://tela.gg/${slug}`, slug },
    };
  }

  async ping() {
    this.pings += 1;
    if (this.pingError !== null) return { ok: false as const, error: this.pingError };
    return { ok: true as const, value: { viewers: this.viewers } };
  }

  stopBeacon(slug: string, ownerToken: string): void {
    this.beacons.push({ slug, ownerToken });
  }

  async liveStatus() {
    return this.live
      ? { ok: true as const, value: { live: true as const, startedAt: 1, viewers: this.viewers } }
      : { ok: true as const, value: { live: false as const } };
  }

  async join() {
    if (this.joinError !== null) return { ok: false as const, error: this.joinError };
    return { ok: true as const, value: { connection: this.connection, identity: 'v_test' } };
  }
}

/**
 * API cuja resposta de `startBroadcast` fica pendurada até você soltar.
 *
 * Existe para testar a corrida real: o usuário aperta "parar" enquanto o
 * servidor ainda não respondeu. Sem uma porta controlável no meio, essa
 * janela é impossível de reproduzir de forma determinística.
 */
export class GatedApi extends FakeApi {
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async startBroadcast(slug: string) {
    await this.gate;
    return super.startBroadcast(slug);
  }
}

/**
 * Transporte que falha do jeito que o mundo real falha: o `connect` rejeita
 * E o evento `closed` dispara. Os dois. É essa dupla notificação que
 * transformava uma falha em duas tentativas de reconexão, depois quatro.
 */
export class ClosingViewerTransport implements ViewerTransport {
  private readonly emitter = new Emitter<ViewerEvents>();
  connects = 0;
  closes = 0;

  async connect(): Promise<void> {
    this.connects += 1;
    this.emitter.emit('closed', { reason: 'SIGNAL_CLOSED' });
    throw new Error('SIGNAL_CLOSED');
  }
  async readStats(): Promise<TransportStats | null> {
    return null;
  }
  on<K extends keyof ViewerEvents>(event: K, handler: (p: ViewerEvents[K]) => void) {
    return this.emitter.on(event, handler);
  }
  async close(): Promise<void> {
    this.closes += 1;
  }
}

/**
 * Transporte cujo `connect` fica pendurado até você soltar, e só então entrega
 * a mídia.
 *
 * Reproduz a janela real entre "pedi a conexão" e "o primeiro frame chegou" —
 * segundos, em rede ruim. É nessa janela que o usuário fecha a aba.
 */
export class GatedViewerTransport implements ViewerTransport {
  readonly emitter = new Emitter<ViewerEvents>();
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  closed = false;
  readonly stream = { getAudioTracks: () => [] } as unknown as MediaStream;

  /** Simula o primeiro frame chegando. */
  deliver(): void {
    this.release();
  }

  async connect(_connection: Connection, sink: (stream: MediaStream) => void): Promise<void> {
    await this.gate;
    sink(this.stream);
  }
  async readStats(): Promise<TransportStats | null> {
    return null;
  }
  on<K extends keyof ViewerEvents>(event: K, handler: (p: ViewerEvents[K]) => void) {
    return this.emitter.on(event, handler);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.release();
  }
  emit<K extends keyof ViewerEvents>(event: K, payload: ViewerEvents[K]): void {
    this.emitter.emit(event, payload);
  }
}

export class FakeStorage implements Storage {
  readonly rows = new Map<string, string>();
  get(key: string) {
    return this.rows.get(key) ?? null;
  }
  set(key: string, value: string) {
    this.rows.set(key, value);
  }
  remove(key: string) {
    this.rows.delete(key);
  }
}

export class FakeRandom implements Random {
  constructor(private readonly fill = 7) {}
  bytes(length: number): Uint8Array {
    return new Uint8Array(length).fill(this.fill);
  }
}
