import { Emitter } from '../emitter.js';
import type { MediaStats, MediaTransport } from '../ports/media-transport.js';
import type { Cancel, Scheduler } from '../ports/scheduler.js';
import { isSignalingError } from '../ports/signaling-channel.js';

/**
 * A sessão do espectador. Sem React e sem conhecer o transporte concreto.
 *
 * Ela cuida do caso que decide o produto para quem recebe o link: o amigo abre
 * a página antes do jogo começar. Em vez de erro, ele vê "offline" e a página
 * conecta sozinha quando a transmissão subir.
 */
export type ViewerState =
  | { readonly status: 'checking' }
  | { readonly status: 'offline'; readonly slug: string; readonly nextPollMs: number }
  | { readonly status: 'connecting'; readonly slug: string }
  | {
      readonly status: 'watching';
      readonly slug: string;
      readonly stream: MediaStream;
      readonly hasAudio: boolean;
      readonly stats: MediaStats | null;
    }
  | { readonly status: 'reconnecting'; readonly slug: string }
  | { readonly status: 'full'; readonly slug: string };

export type ViewerEventMap = { state: ViewerState };

export type ViewerSessionDeps = {
  /** Fábrica: cada tentativa precisa de um canal novo, não de um reaberto. */
  transport: () => MediaTransport;
  scheduler: Scheduler;
  statsIntervalMs?: number;
};

/** Polling de 5s com backoff até 30s: a aba pode ficar aberta a tarde inteira. */
const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 30_000;
const POLL_FACTOR = 1.5;
const STATS_INTERVAL_MS = 1_000;
/**
 * Teto para a negociação. O `watch` só entrega mídia quando o primeiro frame
 * chega — e se a oferta nunca vier, a promessa não resolve NEM rejeita. Sem
 * este relógio a aba fica "conectando" para sempre.
 */
const CONNECT_TIMEOUT_MS = 15_000;

export class ViewerSession {
  private readonly emitter = new Emitter<ViewerEventMap>();
  private state: ViewerState = { status: 'checking' };
  private transport: MediaTransport | null = null;
  private stream: MediaStream | null = null;

  /**
   * Duas listas separadas, e a separação é o que impede a tempestade de
   * reconexão. `transportCancels` morre junto com o transporte; `retryCancel`
   * é uma vaga ÚNICA, então agendar de novo substitui em vez de somar.
   */
  private transportCancels: Cancel[] = [];
  private retryCancel: Cancel | null = null;

  private epoch = 0;
  private pollMs = POLL_MIN_MS;
  private slug = '';
  private disposed = false;

  constructor(private readonly deps: ViewerSessionDeps) {}

  getState(): ViewerState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    return this.emitter.on('state', listener);
  }

  private setState(next: ViewerState): void {
    this.state = next;
    this.emitter.emit('state', next);
  }

  private stale(epoch: number): boolean {
    return this.disposed || this.epoch !== epoch;
  }

  async open(slug: string): Promise<void> {
    // O epoch sobe ANTES de qualquer await. React em StrictMode monta, desmonta
    // e monta de novo, então dois `open` correm juntos — e o segundo precisa
    // invalidar o primeiro no instante em que começa, não depois do primeiro
    // `await`. Sem isso os dois seguem vivos e um pisa no outro.
    this.epoch += 1;
    const epoch = this.epoch;

    this.slug = slug;
    this.disposed = false;
    this.pollMs = POLL_MIN_MS;

    this.cancelRetry();
    await this.dropTransport();
    if (this.stale(epoch)) return;

    this.setState({ status: 'checking' });
    await this.attempt(epoch);
  }

  private async attempt(epoch: number): Promise<void> {
    if (this.stale(epoch)) return;
    this.retryCancel = null;

    this.setState({ status: 'connecting', slug: this.slug });

    /**
     * O transporte é LOCAL desta tentativa até dar certo.
     *
     * Publicá-lo em `this.transport` antes da hora fazia uma tentativa obsoleta
     * derrubar, na limpeza dela, o transporte de uma tentativa viva — e a
     * rejeição que sobrava era reportada como "offline" quando o motivo real
     * era outro (canal cheio, por exemplo). Estado de uma tentativa só vira
     * estado da sessão quando a tentativa vence.
     */
    const transport = this.deps.transport();
    const cancels: Cancel[] = [];

    let delivered = false;
    cancels.push(
      transport.on('track', ({ stream }) => {
        if (this.stale(epoch)) return;
        delivered = true;
        this.pollMs = POLL_MIN_MS;
        this.stream = stream;
        this.setState({
          status: 'watching',
          slug: this.slug,
          stream,
          hasAudio: stream.getAudioTracks().length > 0,
          stats: null,
        });
      }),
      transport.on('reconnecting', () => {
        if (this.state.status === 'watching') {
          this.setState({ status: 'reconnecting', slug: this.slug });
        }
      }),
      // Sem este par, `reconnecting` era beco sem saída: a rota renderiza o
      // estado offline para qualquer status ≠ watching e desmonta o <video>,
      // então a mídia voltava e a tela ficava morta.
      transport.on('reconnected', () => this.onReconnected(epoch)),
      transport.on('closed', () => void this.onClosed(epoch)),
    );

    const abandonar = async (): Promise<void> => {
      for (const cancel of cancels) cancel();
      cancels.length = 0;
      if (this.transport === transport) {
        this.transport = null;
        this.stream = null;
      }
      await transport.disconnect();
    };

    try {
      await this.withTimeout(transport.watch(this.slug), epoch, () => delivered);
    } catch (error) {
      await abandonar();
      if (this.stale(epoch)) return;
      if (isSignalingError(error) && error.code === 'CHANNEL_FULL') {
        // Sala cheia não é erro permanente: alguém sai, a vaga abre.
        this.setState({ status: 'full', slug: this.slug });
        this.advanceBackoff();
      } else {
        this.goOffline();
      }
      return this.scheduleRetry(epoch);
    }

    if (this.stale(epoch)) {
      await abandonar();
      return;
    }

    // Venceu: agora sim vira estado da sessão.
    cancels.push(
      this.deps.scheduler.every(this.deps.statsIntervalMs ?? STATS_INTERVAL_MS, () =>
        void this.sampleStats(),
      ),
    );
    this.transport = transport;
    this.transportCancels = cancels;
  }

  /**
   * Corre a promessa contra o relógio. `stillPending` existe porque em mesh a
   * negociação pode resolver antes do primeiro frame: o que importa é a mídia
   * ter chegado, não o `watch` ter retornado.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    epoch: number,
    delivered: () => boolean,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cancel = this.deps.scheduler.after(CONNECT_TIMEOUT_MS, () => {
        if (settled || this.stale(epoch) || delivered()) return;
        settled = true;
        reject(new Error('CONNECT_TIMEOUT'));
      });
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          cancel();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cancel();
          reject(error);
        },
      );
    });
  }

  private async sampleStats(): Promise<void> {
    if (this.state.status !== 'watching' || this.transport === null) return;
    const stats = await this.transport.getAggregateStats();
    if (stats === null) return;
    if (this.state.status !== 'watching') return;
    this.setState({ ...this.state, stats });
  }

  private onReconnected(epoch: number): void {
    if (this.stale(epoch)) return;
    if (this.state.status !== 'reconnecting') return;
    const stream = this.stream;
    if (stream === null) return;
    this.setState({
      status: 'watching',
      slug: this.slug,
      stream,
      hasAudio: stream.getAudioTracks().length > 0,
      stats: null,
    });
  }

  private async onClosed(epoch: number): Promise<void> {
    if (this.stale(epoch)) return;
    await this.dropTransport();
    if (this.stale(epoch)) return;
    this.pollMs = POLL_MIN_MS;
    this.goOffline();
    this.scheduleRetry(epoch);
  }

  private goOffline(): void {
    this.setState({ status: 'offline', slug: this.slug, nextPollMs: this.pollMs });
  }

  private advanceBackoff(): void {
    this.pollMs = Math.min(Math.round(this.pollMs * POLL_FACTOR), POLL_MAX_MS);
  }

  /**
   * Vaga única. Chamar duas vezes na mesma rodada — o que acontece quando a
   * negociação rejeita E o transporte emite `closed` — não agenda duas
   * tentativas nem avança o backoff duas vezes.
   */
  private scheduleRetry(epoch: number): void {
    if (this.stale(epoch)) return;
    if (this.retryCancel !== null) return;

    const delay = this.pollMs;
    this.advanceBackoff();
    this.retryCancel = this.deps.scheduler.after(delay, () => {
      this.retryCancel = null;
      void this.attempt(epoch);
    });
  }

  private cancelRetry(): void {
    this.retryCancel?.();
    this.retryCancel = null;
  }

  private async dropTransport(): Promise<void> {
    for (const cancel of this.transportCancels) cancel();
    this.transportCancels = [];
    this.stream = null;
    const transport = this.transport;
    this.transport = null;
    await transport?.disconnect();
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.epoch += 1;
    this.cancelRetry();
    await this.dropTransport();
  }
}
