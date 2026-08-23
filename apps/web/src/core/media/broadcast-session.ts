import type { Connection } from '@tela/shared';
import { HEARTBEAT_MS, type TelaApi } from '../api/client.js';
import { Emitter } from '../emitter.js';
import type { AudioCapture } from '../ports/audio-capture.js';
import type {
  PublisherTransport,
  QualityLimitation,
  TransportFactory,
  TransportStats,
} from '../ports/media-transport.js';
import type { Scheduler } from '../ports/scheduler.js';
import type { ScreenCapture } from '../ports/screen-capture.js';
import {
  CONTENT_HINT,
  DEFAULT_PRESET_ID,
  type PresetId,
  nextPresetOnCpuPressure,
  presetById,
  toPublishRequest,
} from './presets.js';

/**
 * O coração do produto, e o único lugar onde a transmissão existe como conceito.
 *
 * Classe pura: zero React, zero DOM além de `MediaStreamTrack`, zero
 * `livekit-client`. É esta restrição (AGENTS.md R1) que faz a Fase 3 ser um
 * port de UI e não uma reescrita — em Tauri, troca-se o adapter de captura e
 * o de transporte, e este arquivo continua idêntico.
 */

export type BroadcastFailure =
  | 'CAPTURE_DENIED'
  | 'CAPTURE_UNSUPPORTED'
  | 'OWNER_INVALID'
  | 'UPSTREAM_UNAVAILABLE'
  | 'TRANSPORT_FAILED'
  | 'USER_STOPPED'
  | 'CAPTURE_ENDED';

/**
 * União discriminada: estado impossível não é representável.
 * Não existe `live` sem tracks, nem `ended` sem motivo.
 */
export type BroadcastState =
  | { readonly status: 'idle' }
  | { readonly status: 'requesting-capture' }
  | { readonly status: 'connecting'; readonly shareUrl: string | null }
  | {
      readonly status: 'live';
      readonly shareUrl: string;
      readonly slug: string;
      readonly presetId: PresetId;
      /** `true` quando o preset atual foi imposto pela pressão de CPU, não escolhido. */
      readonly presetForced: boolean;
      readonly viewers: number;
      readonly stats: TransportStats | null;
      readonly hasAudio: boolean;
      readonly transport: Connection['transport'];
    }
  | { readonly status: 'reconnecting'; readonly shareUrl: string; readonly slug: string }
  | { readonly status: 'ended'; readonly reason: BroadcastFailure };

export type BroadcastEvents = {
  state: BroadcastState;
  /** Só para efeito de UI (copiar link). A sessão não conhece clipboard. */
  started: { shareUrl: string };
};

export type BroadcastSessionDeps = {
  api: TelaApi;
  transports: TransportFactory;
  screen: ScreenCapture;
  audio: AudioCapture;
  scheduler: Scheduler;
  statsIntervalMs?: number;
};

const STATS_INTERVAL_MS = 1_000;
/** Quantas leituras seguidas com `cpu` antes de cair de preset. */
const CPU_PRESSURE_SAMPLES = 5;

export class BroadcastSession {
  private readonly emitter = new Emitter<BroadcastEvents>();

  private state: BroadcastState = { status: 'idle' };
  private transport: PublisherTransport | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private stopTimers: Array<() => void> = [];
  private unsubscribes: Array<() => void> = [];
  private presetId: PresetId = DEFAULT_PRESET_ID;
  private presetForced = false;
  private cpuPressure = 0;
  /**
   * Última contagem conhecida de espectadores.
   *
   * Sobrevive à travessia `live → reconnecting → live`: quem estava assistindo
   * não sumiu porque o transmissor perdeu o socket por dois segundos, e zerar
   * o número no HUD faz o usuário achar que perdeu a audiência.
   */
  private viewers = 0;
  private credentials: { slug: string; ownerToken: string } | null = null;
  private transportKind: Connection['transport'] = 'sfu';

  /**
   * Toda etapa assíncrona do `start()` carrega o epoch em que começou.
   * `stop()` e `fail()` incrementam.
   *
   * Sem isso, parar durante o `connecting` era desfeito: a resposta da API
   * chegava depois, o código seguia publicando e a sessão voltava para `live`
   * com as trilhas já paradas — transmissão fantasma, com heartbeat batendo
   * sem credencial.
   */
  private epoch = 0;

  constructor(private readonly deps: BroadcastSessionDeps) {}

  getState(): BroadcastState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    return this.emitter.on('state', listener);
  }

  on<K extends keyof BroadcastEvents>(
    event: K,
    handler: (payload: BroadcastEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  private setState(next: BroadcastState): void {
    this.state = next;
    this.emitter.emit('state', next);
  }

  /**
   * Transição idle → requesting-capture → connecting → live.
   * Qualquer falha no caminho leva direto a `ended` com o motivo real — nunca
   * a um estado intermediário travado.
   */
  async start(
    slug: string,
    ownerToken: string,
    options: { audioDeviceId?: string; presetId?: PresetId } = {},
  ): Promise<void> {
    if (this.state.status !== 'idle' && this.state.status !== 'ended') return;

    this.epoch += 1;
    const epoch = this.epoch;

    this.credentials = { slug, ownerToken };
    this.presetId = options.presetId ?? DEFAULT_PRESET_ID;
    this.presetForced = false;
    this.cpuPressure = 0;
    this.viewers = 0;
    this.setState({ status: 'requesting-capture' });

    const preset = presetById(this.presetId);

    if (!this.deps.screen.isSupported()) {
      return this.fail('CAPTURE_UNSUPPORTED');
    }

    let capture;
    try {
      capture = await this.deps.screen.request({
        width: preset.layers[0].width,
        height: preset.layers[0].height,
        frameRate: preset.main.maxFramerate,
        systemAudio: true,
      });
    } catch (error) {
      if (this.stale(epoch)) return;
      return this.fail(error === 'UNSUPPORTED' ? 'CAPTURE_UNSUPPORTED' : 'CAPTURE_DENIED');
    }

    // O usuário pode ter desistido durante o picker do sistema.
    if (this.stale(epoch)) {
      capture.video.stop();
      capture.audio?.stop();
      return;
    }

    this.videoTrack = capture.video;
    this.audioTrack = capture.audio;

    /**
     * A linha que decide se o produto presta.
     *
     * O default do Chrome para captura de tela é `detail`: ele preserva
     * nitidez sacrificando framerate, porque assume que você está mostrando
     * um documento. Gameplay a 15fps nítido é inútil.
     */
    this.videoTrack.contentHint = CONTENT_HINT;

    // Linux: sem áudio do sistema no getDisplayMedia. O usuário escolheu um
    // monitor de sink virtual; capturamos com todo processamento de voz
    // desligado (§10).
    if (this.audioTrack === null && options.audioDeviceId) {
      try {
        this.audioTrack = await this.deps.audio.capture(options.audioDeviceId);
      } catch {
        this.audioTrack = null; // transmitir mudo é melhor que não transmitir
      }
      if (this.stale(epoch)) return this.abandon();
    }

    // O usuário pode encerrar pelo controle nativo do browser, fora da nossa UI.
    this.videoTrack.addEventListener('ended', () => void this.stop('CAPTURE_ENDED'));

    this.setState({ status: 'connecting', shareUrl: null });

    const started = await this.deps.api.startBroadcast(slug, ownerToken);
    if (this.stale(epoch)) return this.abandon();
    if (!started.ok) {
      return this.fail(started.error === 'OWNER_INVALID' ? 'OWNER_INVALID' : 'UPSTREAM_UNAVAILABLE');
    }

    const { connection, shareUrl } = started.value;
    this.setState({ status: 'connecting', shareUrl });

    const transport = await this.deps.transports.publisher(connection.transport);
    if (this.stale(epoch)) {
      await transport.close();
      return this.abandon();
    }
    this.transport = transport;
    this.transportKind = connection.transport;

    try {
      await transport.connect(connection);
      if (this.stale(epoch)) return this.abandon();
      await transport.publish(toPublishRequest(preset, this.videoTrack, this.audioTrack));
    } catch {
      if (this.stale(epoch)) return this.abandon();
      return this.fail('TRANSPORT_FAILED');
    }
    if (this.stale(epoch)) return this.abandon();

    this.unsubscribes.push(
      transport.on('viewers', (viewers) => this.onViewers(viewers)),
      transport.on('reconnecting', () => this.onReconnecting()),
      transport.on('reconnected', () => this.onReconnected()),
      transport.on('closed', () => void this.stop('TRANSPORT_FAILED')),
    );

    this.setState({
      status: 'live',
      shareUrl,
      slug,
      presetId: this.presetId,
      presetForced: false,
      viewers: 0,
      stats: null,
      hasAudio: this.audioTrack !== null,
      transport: connection.transport,
    });

    this.startTimers();
    this.emitter.emit('started', { shareUrl });
  }

  private startTimers(): void {
    const { scheduler } = this.deps;
    const interval = this.deps.statsIntervalMs ?? STATS_INTERVAL_MS;

    this.stopTimers.push(
      scheduler.every(HEARTBEAT_MS, () => void this.heartbeat()),
      scheduler.every(interval, () => void this.sampleStats()),
    );
  }

  private async heartbeat(): Promise<void> {
    if (this.credentials === null) return;
    const { slug, ownerToken } = this.credentials;
    const result = await this.deps.api.ping(slug, ownerToken);
    if (!result.ok) {
      // O servidor não sabe mais desta transmissão. Insistir só mantém uma
      // UI mentindo "AO VIVO" para uma sala que não existe.
      if (result.error === 'NOT_LIVE') await this.stop('UPSTREAM_UNAVAILABLE');
      return;
    }
    this.onViewers(result.value.viewers);
  }

  private async sampleStats(): Promise<void> {
    if (this.state.status !== 'live' || this.transport === null) return;
    const stats = await this.transport.readStats();
    if (stats === null) return;

    this.setState({ ...this.state, stats });
    this.trackCpuPressure(stats.limitation);
  }

  /**
   * Degradação automática por CPU.
   *
   * Uma leitura isolada com `cpu` acontece em qualquer keyframe. Só uma
   * sequência sustentada significa encode em software, e aí o único remédio é
   * baixar de preset — devolvendo CPU para o jogo.
   */
  private trackCpuPressure(limitation: QualityLimitation): void {
    if (limitation !== 'cpu') {
      this.cpuPressure = 0;
      return;
    }
    this.cpuPressure += 1;
    if (this.cpuPressure < CPU_PRESSURE_SAMPLES) return;

    const next = nextPresetOnCpuPressure(this.presetId);
    this.cpuPressure = 0;
    if (next === null || this.transport === null || this.videoTrack === null) return;

    this.presetId = next;
    this.presetForced = true;
    if (this.state.status === 'live') {
      this.setState({ ...this.state, presetId: next, presetForced: true });
    }
    void this.transport.publish(
      toPublishRequest(presetById(next), this.videoTrack, this.audioTrack),
    );
  }

  /**
   * Troca de qualidade escolhida pelo usuário, com a transmissão no ar.
   *
   * Republica sem derrubar ninguém: o transporte renegocia com quem já está
   * assistindo. Escolher manualmente também limpa o estado "forçado pela CPU"
   * — se o usuário insiste em 1080p com o encoder no limite, o produto avisa,
   * mas obedece, e a degradação automática volta a valer depois.
   */
  async setPreset(next: PresetId): Promise<void> {
    if (this.state.status !== 'live') {
      this.presetId = next;
      return;
    }
    if (next === this.presetId) return;
    if (this.transport === null || this.videoTrack === null) return;

    this.presetId = next;
    this.presetForced = false;
    this.cpuPressure = 0;
    this.setState({ ...this.state, presetId: next, presetForced: false });

    await this.transport.publish(
      toPublishRequest(presetById(next), this.videoTrack, this.audioTrack),
    );
  }

  private onViewers(viewers: number): void {
    this.viewers = viewers;
    if (this.state.status !== 'live') return;
    if (this.state.viewers === viewers) return;
    this.setState({ ...this.state, viewers });
  }

  private onReconnecting(): void {
    if (this.state.status !== 'live') return;
    this.setState({
      status: 'reconnecting',
      shareUrl: this.state.shareUrl,
      slug: this.state.slug,
    });
  }

  private onReconnected(): void {
    if (this.state.status !== 'reconnecting') return;
    this.setState({
      status: 'live',
      shareUrl: this.state.shareUrl,
      slug: this.state.slug,
      presetId: this.presetId,
      presetForced: this.presetForced,
      viewers: this.viewers,
      stats: null,
      hasAudio: this.audioTrack !== null,
      transport: this.transportKind,
    });
  }

  /** `true` quando um `stop()` ou `fail()` aconteceu enquanto este await corria. */
  private stale(epoch: number): boolean {
    return this.epoch !== epoch;
  }

  /**
   * Sai de um `start()` que perdeu a corrida. Não muda o estado — quem venceu
   * já o definiu — mas solta o que este start alcançou a criar.
   */
  private abandon(): void {
    this.teardown();
  }

  async stop(reason: BroadcastFailure = 'USER_STOPPED'): Promise<void> {
    if (this.state.status === 'idle' || this.state.status === 'ended') return;

    this.epoch += 1;
    const credentials = this.credentials;
    this.teardown();

    if (credentials !== null) {
      // `beacon` porque `stop` também é chamado no `beforeunload`, onde uma
      // requisição normal é cancelada antes de sair.
      this.deps.api.stopBeacon(credentials.slug, credentials.ownerToken);
    }
    this.setState({ status: 'ended', reason });
  }

  private fail(reason: BroadcastFailure): void {
    this.epoch += 1;
    this.teardown();
    this.setState({ status: 'ended', reason });
  }

  private teardown(): void {
    for (const cancel of this.stopTimers) cancel();
    this.stopTimers = [];
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];

    this.videoTrack?.stop();
    this.audioTrack?.stop();
    this.videoTrack = null;
    this.audioTrack = null;

    void this.transport?.close();
    this.transport = null;
    this.credentials = null;
  }

  /** Só para a UI decidir se pede confirmação ao parar. */
  get viewerCount(): number {
    return this.state.status === 'live' ? this.state.viewers : 0;
  }
}
