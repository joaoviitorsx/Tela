import { Emitter } from '../emitter.js';
import type { TelaApi } from '../api/client.js';
import type {
  TransportFactory,
  TransportStats,
  ViewerTransport,
} from '../ports/media-transport.js';
import type { Scheduler } from '../ports/scheduler.js';

/**
 * A sessão do espectador. Também sem React e sem `livekit-client`.
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

export class ViewerSession {
  private readonly emitter = new Emitter<ViewerEventMap>();
  private state: ViewerState = { status: 'checking' };
  private transport: ViewerTransport | null = null;
  private cancels: Array<() => void> = [];
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

  async open(slug: string): Promise<void> {
    this.slug = slug;
    this.disposed = false;
    this.pollMs = POLL_MIN_MS;
    this.setState({ status: 'checking' });
    await this.attempt();
  }

  private async attempt(): Promise<void> {
    if (this.disposed) return;

    const status = await this.deps.api.liveStatus(this.slug);
    if (this.disposed) return;

    if (!status.ok || !status.value.live) return this.scheduleRetry();

    this.setState({ status: 'connecting', slug: this.slug });

    const joined = await this.deps.api.join(this.slug);
    if (this.disposed) return;

    if (!joined.ok) {
      if (joined.error === 'VIEWER_LIMIT') {
        // Sala cheia não é erro permanente: alguém sai, a vaga abre.
        this.setState({ status: 'failed', slug: this.slug, reason: 'FULL' });
        return this.scheduleRetry();
      }
      return this.scheduleRetry();
    }

    const transport = await this.deps.transports.viewer(joined.value.connection.transport);
    if (this.disposed) {
      await transport.close();
      return;
    }
    this.transport = transport;

    this.cancels.push(
      transport.on('reconnecting', () => {
        if (this.state.status === 'watching') {
          this.setState({ status: 'reconnecting', slug: this.slug });
        }
      }),
      transport.on('reconnected', () => undefined),
      transport.on('closed', () => void this.onClosed()),
    );

    try {
      await transport.connect(joined.value.connection, (stream) => {
        this.pollMs = POLL_MIN_MS;
        this.setState({
          status: 'watching',
          slug: this.slug,
          stream,
          hasAudio: stream.getAudioTracks().length > 0,
          stats: null,
        });
      });
    } catch {
      await this.dropTransport();
      return this.scheduleRetry();
    }

    this.cancels.push(
      this.deps.scheduler.every(this.deps.statsIntervalMs ?? STATS_INTERVAL_MS, () =>
        void this.sampleStats(),
      ),
    );
  }

  private async sampleStats(): Promise<void> {
    if (this.state.status !== 'watching' || this.transport === null) return;
    const stats = await this.transport.readStats();
    if (stats === null) return;
    this.setState({ ...this.state, stats });
  }

  private async onClosed(): Promise<void> {
    if (this.disposed) return;
    await this.dropTransport();
    this.setState({ status: 'offline', slug: this.slug, nextPollMs: POLL_MIN_MS });
    this.pollMs = POLL_MIN_MS;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.disposed) return;
    if (this.state.status !== 'failed') {
      this.setState({ status: 'offline', slug: this.slug, nextPollMs: this.pollMs });
    }
    const delay = this.pollMs;
    this.pollMs = Math.min(Math.round(this.pollMs * POLL_FACTOR), POLL_MAX_MS);
    this.cancels.push(this.deps.scheduler.after(delay, () => void this.attempt()));
  }

  private async dropTransport(): Promise<void> {
    for (const cancel of this.cancels) cancel();
    this.cancels = [];
    const transport = this.transport;
    this.transport = null;
    await transport?.close();
  }

  async close(): Promise<void> {
    this.disposed = true;
    await this.dropTransport();
  }
}
