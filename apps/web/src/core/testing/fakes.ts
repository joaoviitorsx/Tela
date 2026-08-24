import type { EncodingPreset, IceServerConfig } from '@tela/shared';
import { Emitter } from '../emitter.js';
import type { AudioCapture } from '../ports/audio-capture.js';
import type { AudioGain } from '../ports/audio-gain.js';
import type {
  MediaStats,
  MediaTransport,
  PeerInfo,
  TransportEvents,
} from '../ports/media-transport.js';
import type { Random } from '../ports/random.js';
import type { Cancel, Scheduler } from '../ports/scheduler.js';
import type { CaptureSurface, ScreenCapture } from '../ports/screen-capture.js';
import type {
  ChannelEvents,
  ChannelOpened,
  SignalingChannel,
} from '../ports/signaling-channel.js';
import type { Storage } from '../ports/storage.js';

/**
 * Fakes in-memory, não mocks.
 *
 * Um mock verifica que você chamou o método. Um fake verifica que o
 * comportamento resultante está certo — e sobrevive a refatoração da
 * implementação. É o retorno concreto da R1: com a lógica de mídia fora de
 * `useEffect`, os testes de sessão rodam sem browser, sem rede e sem servidor,
 * em milissegundos.
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

  visivel = true;
  private readonly ouvintes = new Set<() => void>();

  isVisible(): boolean {
    return this.visivel;
  }

  onVisibilityChange(handler: () => void): Cancel {
    this.ouvintes.add(handler);
    return () => this.ouvintes.delete(handler);
  }

  /** Só no fake: simula o usuário trocando de aba para jogar. */
  setVisivel(valor: boolean): void {
    this.visivel = valor;
    for (const h of [...this.ouvintes]) h();
  }

  /** Avança o relógio disparando tudo que vencer no caminho. */
  advance(ms: number): void {
    const target = this.time + ms;
    let guard = 0;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined || (guard += 1) > 1_000) break;

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

export type FakeTrack = MediaStreamTrack & {
  stopped: boolean;
  fireEnded(): void;
  constraints: MediaTrackConstraints[];
};

export function fakeTrack(kind: 'video' | 'audio'): FakeTrack {
  const listeners = new Map<string, Set<() => void>>();
  const track = {
    kind,
    id: `${kind}-fake`,
    contentHint: '',
    readyState: 'live' as MediaStreamTrackState,
    stopped: false,
    constraints: [] as MediaTrackConstraints[],
    async applyConstraints(c: MediaTrackConstraints) {
      track.constraints.push(c);
    },
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
  return track as unknown as FakeTrack;
}

export function fakeStream(tracks: MediaStreamTrack[] = []): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    addTrack: (t: MediaStreamTrack) => tracks.push(t),
    removeTrack: (t: MediaStreamTrack) => {
      const i = tracks.indexOf(t);
      if (i >= 0) tracks.splice(i, 1);
    },
  } as unknown as MediaStream;
}

export class FakeScreenCapture implements ScreenCapture {
  supported = true;
  denied = false;
  withAudio = false;
  surface: CaptureSurface = 'monitor';
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
    return {
      video: this.video,
      audio: this.withAudio ? this.audio : null,
      surface: this.surface,
    };
  }
}

export class FakeAudioCapture implements AudioCapture {
  fails = false;
  permitido = true;
  async requestPermission() {
    return this.permitido;
  }
  async listMonitors() {
    return [{ id: 'monitor-1', label: 'TelaCapture Monitor' }];
  }
  async capture() {
    if (this.fails) throw new Error('sem permissão');
    return fakeTrack('audio');
  }
}

/* ─────────────────────────── transporte ─────────────────────────── */

export class FakeMediaTransport implements MediaTransport {
  private readonly emitter = new Emitter<TransportEvents>();

  hosted: { slug: string; ownerToken: string } | null = null;
  watched: string | null = null;
  readonly videos: { track: MediaStreamTrack; preset: EncodingPreset }[] = [];
  readonly audios: MediaStreamTrack[] = [];
  readonly presets: EncodingPreset[] = [];
  disconnected = false;
  stats: MediaStats | null = null;
  currentPeers: readonly PeerInfo[] = [];

  /** Erros injetáveis: `host`/`watch` rejeitam com estes valores. */
  hostError: unknown = null;
  watchError: unknown = null;
  /** Quando true, `watch` nunca settla — o caso da negociação travada. */
  hangOnWatch = false;

  async host(slug: string, ownerToken: string): Promise<void> {
    if (this.hostError !== null) throw this.hostError;
    this.hosted = { slug, ownerToken };
  }

  async watch(slug: string): Promise<void> {
    if (this.watchError !== null) throw this.watchError;
    if (this.hangOnWatch) return new Promise<void>(() => undefined);
    this.watched = slug;
  }

  async publishVideo(track: MediaStreamTrack, preset: EncodingPreset): Promise<void> {
    this.videos.push({ track, preset });
  }
  async publishAudio(track: MediaStreamTrack): Promise<void> {
    this.audios.push(track);
  }
  async setPreset(preset: EncodingPreset): Promise<void> {
    this.presets.push(preset);
  }
  readonly substituidas: MediaStreamTrack[] = [];
  async replaceVideo(track: MediaStreamTrack): Promise<void> {
    this.substituidas.push(track);
  }
  readonly prioridades: string[] = [];
  async setPrioridade(prioridade: string): Promise<void> {
    this.prioridades.push(prioridade);
  }
  ceilings: (number | null)[] = [];
  async setBitrateCeiling(bps: number | null): Promise<void> {
    this.ceilings.push(bps);
  }
  async getAggregateStats(): Promise<MediaStats | null> {
    return this.stats;
  }
  peers(): readonly PeerInfo[] {
    return this.currentPeers;
  }
  on<K extends keyof TransportEvents>(event: K, handler: (p: TransportEvents[K]) => void) {
    return this.emitter.on(event, handler);
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  emit<K extends keyof TransportEvents>(event: K, payload: TransportEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  /** Simula a queda do servidor de sinalização com a mídia ainda fluindo. */
  loseSignaling(): void {
    this.emit('signaling-lost', undefined);
  }

  /** Simula o canal reabrindo sozinho depois da queda. */
  restoreSignaling(): void {
    this.emit('signaling-restored', undefined);
  }

  /** Simula a chegada da mídia no espectador. */
  deliver(stream: MediaStream = fakeStream([fakeTrack('video')])): void {
    this.emit('track', { stream });
  }

  setPeers(peers: readonly PeerInfo[]): void {
    this.currentPeers = peers;
    this.emit('peers', peers);
  }
}

/* ─────────────────────────── sinalização ─────────────────────────── */

export const TEST_ICE: IceServerConfig[] = [{ urls: ['stun:test'] }];

/**
 * Canal de sinalização em memória. Dois clientes ligados ao mesmo `Hub`
 * trocam payload como trocariam pela rede — sem servidor e sem WebSocket.
 */
export class FakeSignalingHub {
  private readonly channels = new Map<string, FakeSignalingChannel>();
  hostId: string | null = null;

  register(channel: FakeSignalingChannel): void {
    this.channels.set(channel.selfId, channel);
    if (channel.role === 'host') this.hostId = channel.selfId;
  }

  deliver(from: string, payload: unknown, to?: string): void {
    const target = to ?? this.hostId;
    if (target === null || target === undefined) return;
    this.channels.get(target)?.receive(from, payload);
  }

  announceJoin(peerId: string): void {
    if (this.hostId === null) return;
    this.channels.get(this.hostId)?.fire('peer-joined', { peerId });
  }

  announceLeave(peerId: string): void {
    if (this.hostId === null) return;
    this.channels.get(this.hostId)?.fire('peer-left', { peerId });
  }
}

export class FakeSignalingChannel implements SignalingChannel {
  private readonly emitter = new Emitter<ChannelEvents>();
  readonly sent: { payload: unknown; to?: string }[] = [];
  closed = false;
  hostError: unknown = null;
  watchError: unknown = null;

  constructor(
    readonly selfId: string,
    readonly role: 'host' | 'viewer',
    private readonly hub?: FakeSignalingHub,
    private readonly maxPeers = 3,
  ) {
    hub?.register(this);
  }

  async host(): Promise<ChannelOpened> {
    if (this.hostError !== null) throw this.hostError;
    return {
      role: 'host',
      selfId: this.selfId,
      hostId: null,
      iceServers: TEST_ICE,
      maxPeers: this.maxPeers,
      viewers: 0,
    };
  }

  async watch(): Promise<ChannelOpened> {
    if (this.watchError !== null) throw this.watchError;
    return {
      role: 'viewer',
      selfId: this.selfId,
      hostId: this.hub?.hostId ?? 'h_1',
      viewers: 1,
      iceServers: TEST_ICE,
      maxPeers: 0,
    };
  }

  send(payload: unknown, to?: string): void {
    this.sent.push(to === undefined ? { payload } : { payload, to });
    this.hub?.deliver(this.selfId, payload, to);
  }

  on<K extends keyof ChannelEvents>(event: K, handler: (p: ChannelEvents[K]) => void) {
    return this.emitter.on(event, handler);
  }

  close(): void {
    this.closed = true;
  }

  /** Só no fake: entrega um payload como se tivesse vindo da rede. */
  receive(from: string, payload: unknown): void {
    this.emitter.emit('signal', { from, payload });
  }

  fire<K extends keyof ChannelEvents>(event: K, payload: ChannelEvents[K]): void {
    this.emitter.emit(event, payload);
  }
}

/* ─────────────────────────── outros ─────────────────────────── */

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

export const shareUrlFor = (slug: string) => `https://tela.gg/${slug}`;

export const createStream = (tracks: readonly MediaStreamTrack[]): MediaStream =>
  fakeStream([...tracks]);

/** Política de slug enxuta: o teste não deve depender da blocklist real. */
export const TEST_POLICY = {
  reserved: new Set(['api', 'signal', 'admin']),
  offensive: new Set(['puta']),
};


/**
 * Ganho de áudio falso.
 *
 * Devolve a MESMA trilha de propósito: assim um teste que confunda a trilha
 * crua com a de saída não passa por acidente. Guarda os valores aplicados para
 * quem quiser afirmar sobre eles.
 */
export class FakeAudioGain implements AudioGain {
  readonly aplicados: number[] = [];
  readonly anexadas: MediaStreamTrack[] = [];
  fechado = false;
  ativo = true;

  attach(track: MediaStreamTrack): MediaStreamTrack {
    this.anexadas.push(track);
    return track;
  }

  set(value: number): void {
    this.aplicados.push(value);
  }

  close(): void {
    this.fechado = true;
  }
}
