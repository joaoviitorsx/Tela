import { Emitter } from '../emitter.js';
import type { TelaApi } from '../api/client.js';
import type {
  TransportFactory,
  TransportStats,
  ViewerTransport,
} from '../ports/media-transport.js';
import type { Cancel, Scheduler } from '../ports/scheduler.js';

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
      readonly stats: TransportStats | null;
    }
  | { readonly status: 'reconnecting'; readonly slug: string }
  | { readonly status: 'failed'; readonly slug: string; readonly reason: ViewerFailure };

export type ViewerFailure = 'FULL' | 'TRANSPORT_FAILED' | 'ENDED';

export type ViewerEventMap = { state: ViewerState };

export type ViewerSessionDeps = {
  api: TelaApi;
  transports: TransportFactory;
  scheduler: Scheduler;
  statsIntervalMs?: number;
};

/** Polling de 5s com backoff até 30s: a aba pode ficar aberta a tarde inteira. */
const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 30_000;
const POLL_FACTOR = 1.5;
const STATS_INTERVAL_MS = 1_000;
/**
 * Teto para a negociação. O `connect` de um transporte P2P só resolve quando
 * o primeiro frame chega — e se a oferta SDP nunca vier (transmissor caiu
 * entre o `start` e o `hello`, ICE não fecha, hub aceitou e travou), a
 * promessa não resolve NEM rejeita. Sem este relógio a aba fica "conectando"
 * para sempre, sem nenhum timer agendado para tirá-la de lá.
 */
const CONNECT_TIMEOUT_MS = 15_000;

export class ViewerSession {
  private readonly emitter = new Emitter<ViewerEventMap>();
  private state: ViewerState = { status: 'checking' };
  private transport: ViewerTransport | null = null;

  /**
   * Duas listas separadas, e a separação é o que impede o bug de reconexão.
   *
   * `transportCancels` morre junto com o transporte. `retryCancel` é uma vaga
   * ÚNICA: agendar de novo substitui o agendamento anterior em vez de somar.
   * Quando os dois viviam na mesma lista, uma falha que disparava tanto o
   * `catch` do connect quanto o evento `closed` agendava duas tentativas — e
   * cada uma agendava duas na rodada seguinte: 1, 2, 4, 8, 16, 32.
   */
  private transportCancels: Cancel[] = [];
  private retryCancel: Cancel | null = null;
  /** Guardado para devolver a mídia ao voltar de `reconnecting`. */
  private stream: MediaStream | null = null;

  /**
   * Toda operação assíncrona carrega o epoch em que começou. `open()` e
   * `close()` incrementam. Um `await` que retorna depois de a sessão ter sido
   * fechada ou reaberta encontra o epoch mudado e desiste — sem isso, uma
   * resposta atrasada da API ressuscita uma sessão morta.
   */
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
    await this.dropTransport();
    this.cancelRetry();

    this.epoch += 1;
    this.slug = slug;
    this.disposed = false;
    this.pollMs = POLL_MIN_MS;
    this.setState({ status: 'checking' });
    await this.attempt(this.epoch);
  }

  private async attempt(epoch: number): Promise<void> {
    if (this.stale(epoch)) return;
    this.retryCancel = null; // o agendamento que nos trouxe até aqui já disparou

    const status = await this.deps.api.liveStatus(this.slug);
    if (this.stale(epoch)) return;

    if (!status.ok || !status.value.live) {
      // Offline vindo de qualquer estado — inclusive de `failed` por sala
      // cheia. A transmissão acabou; insistir em "lotada" seria mentira.
      this.goOffline();
      return this.scheduleRetry(epoch);
    }

    this.setState({ status: 'connecting', slug: this.slug });

    const joined = await this.deps.api.join(this.slug);
    if (this.stale(epoch)) return;

    if (!joined.ok) {
      // Sala cheia não é erro permanente: alguém sai, a vaga abre.
      if (joined.error === 'VIEWER_LIMIT') {
        this.setState({ status: 'failed', slug: this.slug, reason: 'FULL' });
        this.advanceBackoff();
      } else {
        this.goOffline();
      }
      return this.scheduleRetry(epoch);
    }

    const transport = await this.deps.transports.viewer(joined.value.connection.transport);
    if (this.stale(epoch)) {
      await transport.close();
      return;
    }
    this.transport = transport;

    this.transportCancels.push(
      transport.on('reconnecting', () => {
        if (this.state.status === 'watching') {
          this.setState({ status: 'reconnecting', slug: this.slug });
        }
      }),
      // Sem este par, `reconnecting` era um beco sem saída: a mídia voltava e
      // a tela ficava morta, porque a rota renderiza o estado offline para
      // qualquer status diferente de `watching` e desmonta o <video>.
      transport.on('reconnected', () => this.onReconnected(epoch)),
      transport.on('closed', () => void this.onClosed(epoch)),
    );

    try {
      await this.withTimeout(
        transport.connect(joined.value.connection, (stream) => {
          // O callback de mídia dispara quando o primeiro frame chega, que
          // pode ser depois de o usuário ter fechado a aba ou trocado de slug.
          // Publicar `watching` aqui ressuscitaria uma sessão morta.
          if (this.stale(epoch)) return;
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
      );
    } catch {
      await this.dropTransport();
      if (this.stale(epoch)) return;
      this.goOffline();
      return this.scheduleRetry(epoch);
    }

    if (this.stale(epoch)) {
      await this.dropTransport();
      return;
    }

    this.transportCancels.push(
      this.deps.scheduler.every(this.deps.statsIntervalMs ?? STATS_INTERVAL_MS, () =>
        void this.sampleStats(),
      ),
    );
  }

  private async sampleStats(): Promise<void> {
    if (this.state.status !== 'watching' || this.transport === null) return;
    const stats = await this.transport.readStats();
    if (stats === null) return;
    if (this.state.status !== 'watching') return;
    this.setState({ ...this.state, stats });
  }

  /**
   * Corre a promessa contra o relógio. Uma negociação que nunca settla vira
   * uma rejeição, que o chamador já sabe transformar em nova tentativa.
   */
  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cancel = this.deps.scheduler.after(CONNECT_TIMEOUT_MS, () => {
        if (settled) return;
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
          reject(error instanceof Error ? error : new Error('CONNECT_FAILED'));
        },
      );
    });
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
   * Vaga única. Chamar duas vezes na mesma rodada — o que acontece quando o
   * `connect` rejeita E o transporte emite `closed` — não agenda duas
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
    await transport?.close();
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.epoch += 1;
    this.cancelRetry();
    await this.dropTransport();
  }
}
