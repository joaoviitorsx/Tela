import { Emitter } from '../emitter.js';
import type { AudioCapture } from '../ports/audio-capture.js';
import type {
  MediaStats,
  MediaTransport,
  PeerInfo,
  QualityLimitation,
} from '../ports/media-transport.js';
import type { Scheduler } from '../ports/scheduler.js';
import type { CaptureSurface, ScreenCapture } from '../ports/screen-capture.js';
import { isSignalingError } from '../ports/signaling-channel.js';
import {
  CONTENT_HINT,
  DEFAULT_PRESET_ID,
  type PresetId,
  nextPresetOnCpuPressure,
  presetById,
} from './presets.js';

/**
 * O coração do produto, e o único lugar onde a transmissão existe como
 * conceito.
 *
 * Classe pura: zero React, zero DOM além de `MediaStreamTrack`, zero SDK de
 * transporte. Essa restrição (AGENTS.md R1) já se pagou uma vez — quando o
 * transporte trocou de SFU para mesh (changeset 001), a máquina de estados,
 * as regras de mídia e a degradação por CPU deste arquivo continuaram
 * valendo. Mudou quem implementa a porta, não quem a usa.
 */
export type BroadcastFailure =
  | 'CAPTURE_DENIED'
  | 'CAPTURE_UNSUPPORTED'
  | 'SLUG_TAKEN'
  | 'SLUG_INVALID'
  | 'RATE_LIMITED'
  | 'SIGNALING_UNAVAILABLE'
  | 'TRANSPORT_FAILED'
  | 'USER_STOPPED'
  | 'CAPTURE_ENDED';

/**
 * União discriminada: estado impossível não é representável.
 * Não existe `live` sem link, nem `ended` sem motivo.
 */
export type BroadcastState =
  | { readonly status: 'idle' }
  | { readonly status: 'requesting-capture' }
  | { readonly status: 'connecting' }
  | {
      readonly status: 'live';
      readonly shareUrl: string;
      readonly slug: string;
      readonly presetId: PresetId;
      readonly presetForced: boolean;
      readonly peers: readonly PeerInfo[];
      readonly maxPeers: number;
      readonly stats: MediaStats | null;
      readonly hasAudio: boolean;
      /**
       * `true` quando o usuário escolheu uma janela ou aba em vez da tela
       * inteira NUM sistema onde isso custa o áudio do sistema.
       *
       * O navegador não avisa: ele simplesmente entrega vídeo sem som, e a
       * pessoa só descobre quando um amigo reclama.
       */
      readonly audioPerdidoPelaEscolha: boolean;
    }
  | { readonly status: 'ended'; readonly reason: BroadcastFailure };

export type BroadcastEvents = {
  state: BroadcastState;
  /** Só para efeito de UI (copiar link). A sessão não conhece clipboard. */
  started: { shareUrl: string };
};

export type BroadcastSessionDeps = {
  transport: MediaTransport;
  screen: ScreenCapture;
  audio: AudioCapture;
  scheduler: Scheduler;
  /** Monta o link público a partir do slug. Sem servidor, quem sabe é o front. */
  shareUrlFor: (slug: string) => string;
  maxPeers?: number;
  statsIntervalMs?: number;
};

const STATS_INTERVAL_MS = 1_000;
/** Quantas leituras seguidas com o mesmo limitador antes de cair de preset. */
const PRESSURE_SAMPLES = 5;

/**
 * Framerate da captura quando NINGUÉM está assistindo.
 *
 * Sem espectador não há encoder rodando — mas a captura de tela continua, e
 * capturar 1080p60 é trabalho real de GPU e de compositor. Numa máquina que
 * está rodando um jogo, isso é custo cobrado por nada.
 *
 * Cinco quadros por segundo mantém a trilha viva (parar e recomeçar traria o
 * seletor de tela de volta, o que é inaceitável) e devolve praticamente todo
 * o custo. O usuário não percebe: não há ninguém do outro lado para ver.
 */
const IDLE_CAPTURE_FPS = 5;

/**
 * Fração da banda estimada que o vídeo pode ocupar.
 *
 * Os 25% de folga são a diferença entre transmitir e estrangular o jogo.
 * Encher o cano faz o pacote do jogo esperar atrás do vídeo na fila do
 * roteador — é assim que o ping sobe, e nenhum ajuste de bitrate resolve
 * depois que a fila encheu.
 */
const UPLINK_SHARE = 0.75;

export class BroadcastSession {
  private readonly emitter = new Emitter<BroadcastEvents>();

  private state: BroadcastState = { status: 'idle' };
  private videoTrack: MediaStreamTrack | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private timers: Array<() => void> = [];
  private unsubscribes: Array<() => void> = [];
  private presetId: PresetId = DEFAULT_PRESET_ID;
  private pressure = 0;
  private pressureKind: QualityLimitation = 'none';
  private capturaOciosa = false;
  private maxPeers = 3;

  /**
   * Toda etapa assíncrona do `start()` carrega o epoch em que começou.
   * `stop()` e `fail()` incrementam.
   *
   * Sem isso, parar durante o `connecting` era desfeito: a negociação chegava
   * depois, o código seguia publicando e a sessão voltava para `live` com as
   * trilhas já paradas.
   */
  private epoch = 0;
  private ceiling: number | null = null;
  private surface: CaptureSurface = 'desconhecido';

  constructor(private readonly deps: BroadcastSessionDeps) {
    this.maxPeers = deps.maxPeers ?? 3;
  }

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

  private stale(epoch: number): boolean {
    return this.epoch !== epoch;
  }

  async start(
    slug: string,
    ownerToken: string,
    options: { audioDeviceId?: string; presetId?: PresetId } = {},
  ): Promise<void> {
    if (this.state.status !== 'idle' && this.state.status !== 'ended') return;

    this.epoch += 1;
    const epoch = this.epoch;

    this.presetId = options.presetId ?? DEFAULT_PRESET_ID;
    this.pressure = 0;
    this.pressureKind = 'none';
    this.capturaOciosa = false;
    this.setState({ status: 'requesting-capture' });

    const preset = presetById(this.presetId);

    if (!this.deps.screen.isSupported()) return this.fail('CAPTURE_UNSUPPORTED');

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
    this.surface = capture.surface;

    /**
     * A linha que decide se o produto presta.
     *
     * O default do Chrome para captura de tela é `detail`: ele preserva
     * nitidez sacrificando framerate, porque assume que você está mostrando um
     * documento. Gameplay a 15fps nítido é inútil.
     */
    this.videoTrack.contentHint = CONTENT_HINT;

    // Linux: sem áudio do sistema no getDisplayMedia. O usuário escolheu um
    // monitor de sink virtual; capturamos com todo processamento de voz
    // desligado.
    if (this.audioTrack === null && options.audioDeviceId !== undefined) {
      try {
        this.audioTrack = await this.deps.audio.capture(options.audioDeviceId);
      } catch {
        this.audioTrack = null; // transmitir mudo é melhor que não transmitir
      }
      if (this.stale(epoch)) return this.abandon();
    }

    // O usuário pode encerrar pelo controle nativo do browser, fora da nossa UI.
    this.videoTrack.addEventListener('ended', () => void this.stop('CAPTURE_ENDED'));

    this.setState({ status: 'connecting' });

    try {
      await this.deps.transport.host(slug, ownerToken);
    } catch (error) {
      if (this.stale(epoch)) return this.abandon();
      return this.fail(failureFor(error));
    }
    if (this.stale(epoch)) return this.abandon();

    this.unsubscribes.push(
      this.deps.transport.on('peers', (peers) => this.onPeers(peers)),
      this.deps.transport.on('closed', () => void this.stop('TRANSPORT_FAILED')),
    );

    try {
      await this.deps.transport.publishVideo(this.videoTrack, preset);
      if (this.audioTrack !== null) await this.deps.transport.publishAudio(this.audioTrack);
    } catch {
      if (this.stale(epoch)) return this.abandon();
      return this.fail('TRANSPORT_FAILED');
    }
    if (this.stale(epoch)) return this.abandon();

    const shareUrl = this.deps.shareUrlFor(slug);
    this.setState({
      status: 'live',
      shareUrl,
      slug,
      presetId: this.presetId,
      presetForced: false,
      peers: [],
      maxPeers: this.maxPeers,
      stats: null,
      hasAudio: this.audioTrack !== null,
      audioPerdidoPelaEscolha:
        this.audioTrack === null &&
        this.surface !== 'monitor' &&
        this.surface !== 'desconhecido',
    });

    this.timers.push(
      this.deps.scheduler.every(this.deps.statsIntervalMs ?? STATS_INTERVAL_MS, () =>
        void this.sampleStats(),
      ),
    );
    this.emitter.emit('started', { shareUrl });
  }

  private async sampleStats(): Promise<void> {
    if (this.state.status !== 'live') return;
    const stats = await this.deps.transport.getAggregateStats();
    if (stats === null) return;
    if (this.state.status !== 'live') return;

    this.setState({ ...this.state, stats });
    this.applyUplinkCeiling(stats.availableBps);
    this.trackPressure(stats.limitation);
  }

  /**
   * Impede o encoder de encher o cano do usuário.
   *
   * O WebRTC estima quanto cabe no link e sobe até lá. "Até lá" é exatamente
   * onde a fila do roteador enche e o ping do jogo dispara — e quando o
   * controle de congestionamento percebe, o jogador já sentiu. Então o teto é
   * aplicado ANTES: o vídeo nunca pede mais do que uma fração do estimado.
   */
  private applyUplinkCeiling(availableBps: number | null): void {
    if (availableBps === null || availableBps <= 0) return;
    const teto = Math.round(availableBps * UPLINK_SHARE);
    if (teto === this.ceiling) return;
    this.ceiling = teto;
    void this.deps.transport.setBitrateCeiling(teto).catch(() => undefined);
  }

  /**
   * Degradação automática por CPU.
   *
   * Uma leitura isolada com `cpu` acontece em qualquer keyframe. Só uma
   * sequência sustentada significa encode em software, e aí o único remédio é
   * codificar menos pixel — devolvendo CPU para o jogo.
   */
  /**
   * Degradação automática, por CPU **ou por banda**.
   *
   * A versão anterior só olhava `cpu` e ignorava `bandwidth` — o WebRTC dizia
   * em letras garrafais "estou limitado pela rede" e o produto não fazia nada,
   * continuava pedindo 8 Mbps de um link que não tinha. Era o caminho direto
   * para o ping do jogo subir.
   */
  private trackPressure(limitation: QualityLimitation): void {
    if (limitation !== 'cpu' && limitation !== 'bandwidth') {
      this.pressure = 0;
      this.pressureKind = 'none';
      return;
    }
    if (limitation !== this.pressureKind) {
      this.pressureKind = limitation;
      this.pressure = 0;
    }
    this.pressure += 1;
    if (this.pressure < PRESSURE_SAMPLES) return;

    const next = nextPresetOnCpuPressure(this.presetId);
    this.pressure = 0;
    if (next === null) return;

    this.presetId = next;
    if (this.state.status === 'live') {
      this.setState({ ...this.state, presetId: next, presetForced: true });
    }
    // `catch` obrigatório: fire-and-forget aqui já produziu unhandled
    // rejection quando colidiu com uma troca manual de qualidade.
    void this.deps.transport.setPreset(presetById(next)).catch(() => undefined);
  }

  /**
   * Troca de qualidade escolhida pelo usuário, com a transmissão no ar.
   *
   * Em mesh isso é `setParameters` nos senders existentes: nenhuma
   * renegociação, ninguém pisca. Escolher manualmente limpa a marca de
   * "forçado pela CPU" — se o usuário insiste em 1080p com o encoder no
   * limite, o produto avisa, mas obedece.
   */
  async setPreset(next: PresetId): Promise<void> {
    if (this.state.status !== 'live') {
      this.presetId = next;
      return;
    }
    if (next === this.presetId) return;

    this.presetId = next;
    this.pressure = 0;
    this.pressureKind = 'none';
    this.setState({ ...this.state, presetId: next, presetForced: false });
    await this.deps.transport.setPreset(presetById(next));
  }

  private onPeers(peers: readonly PeerInfo[]): void {
    this.throttleIdleCapture(peers.length === 0);
    if (this.state.status !== 'live') return;
    this.setState({ ...this.state, peers });
  }

  /**
   * Com zero espectadores, captura a 5fps.
   *
   * Não há encoder rodando sem peer — mas a captura de tela continua, e a
   * 1080p60 ela custa GPU e compositor numa máquina que está rodando um jogo.
   * Ninguém está do outro lado para ver a diferença.
   */
  private throttleIdleCapture(ocioso: boolean): void {
    if (ocioso === this.capturaOciosa) return;
    const track = this.videoTrack;
    if (track === null || typeof track.applyConstraints !== 'function') return;

    this.capturaOciosa = ocioso;
    const alvo = ocioso ? IDLE_CAPTURE_FPS : presetById(this.presetId).main.maxFramerate;
    void track.applyConstraints({ frameRate: alvo }).catch(() => {
      // Navegador que recusa restringir a captura continua no framerate cheio.
      this.capturaOciosa = false;
    });
  }

  /**
   * A transição vem ANTES da limpeza, e a ordem importa.
   *
   * Enquanto `stop()` esperava o teardown para só então marcar `ended`, a
   * sessão passava um intervalo em `connecting` já condenada — e um `start()`
   * que chegasse nesse intervalo era recusado pela guarda de status. É
   * exatamente o que acontece no ciclo montar/desmontar/montar do React em
   * StrictMode: o remount pedia para transmitir, era recusado em silêncio, e
   * o usuário via "Transmissão encerrada" sem nada ter acontecido.
   *
   * Marcar primeiro também é melhor para quem clica em "parar": a UI responde
   * na hora, e a liberação de câmera, socket e timers segue por baixo.
   */
  async stop(reason: BroadcastFailure = 'USER_STOPPED'): Promise<void> {
    if (this.state.status === 'idle' || this.state.status === 'ended') return;
    this.epoch += 1;
    this.setState({ status: 'ended', reason });
    await this.teardown();
  }

  private fail(reason: BroadcastFailure): void {
    this.epoch += 1;
    void this.teardown();
    this.setState({ status: 'ended', reason });
  }

  /** Sai de um `start()` que perdeu a corrida, sem tocar no estado. */
  private abandon(): void {
    void this.teardown();
  }

  private async teardown(): Promise<void> {
    for (const cancel of this.timers) cancel();
    this.timers = [];
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];

    this.videoTrack?.stop();
    this.audioTrack?.stop();
    this.videoTrack = null;
    this.audioTrack = null;
    this.ceiling = null;
    this.capturaOciosa = false;

    await this.deps.transport.disconnect();
  }

  /** Só para a UI decidir se pede confirmação ao parar. */
  get viewerCount(): number {
    return this.state.status === 'live' ? this.state.peers.length : 0;
  }
}

function failureFor(error: unknown): BroadcastFailure {
  if (!isSignalingError(error)) return 'SIGNALING_UNAVAILABLE';
  switch (error.code) {
    case 'SLUG_TAKEN':
    case 'OWNER_INVALID':
      // O usuário não distingue "é de outro" de "meu token não bate", e a
      // ação é a mesma: escolher outro nome.
      return 'SLUG_TAKEN';
    case 'SLUG_INVALID':
      return 'SLUG_INVALID';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    default:
      return 'SIGNALING_UNAVAILABLE';
  }
}
