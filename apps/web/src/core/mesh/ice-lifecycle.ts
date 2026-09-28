import type { IceCredentials, SignalingChannel } from '../ports/signaling-channel.js';
import type { Cancel, Scheduler } from '../ports/scheduler.js';

/** Renovação de credenciais sem reiniciar uma conexão que segue saudável. */
export class IceLifecycle {
  private lease: IceCredentials | null = null;
  private renewDue = Infinity;
  private timer: Cancel | null = null;
  private visibility: Cancel;
  private pending: Promise<boolean> | null = null;
  private closed = false;

  constructor(
    private readonly channel: Pick<SignalingChannel, 'refreshIce'>,
    private readonly scheduler: Scheduler,
    private readonly apply: (lease: IceCredentials) => void,
    private readonly random: () => number = Math.random,
  ) {
    this.visibility = scheduler.onVisibilityChange(() => {
      if (this.lease?.expiresAt !== undefined && this.scheduler.now() >= this.renewAt()) {
        void this.refresh();
      }
    });
  }

  use(lease: IceCredentials): void {
    if (this.closed) return;
    if (lease.relayStatus === 'unavailable' && this.lease !== null) {
      this.arm(5_000);
      return;
    }
    const issuedAt = lease.issuedAt ?? this.scheduler.now();
    this.lease = { ...lease, issuedAt };
    if (lease.expiresAt !== undefined) {
      const ttl = Math.max(0, lease.expiresAt - issuedAt);
      const margin = Math.max(1_000, Math.min(60_000, ttl * 0.2));
      this.renewDue = lease.expiresAt - margin - Math.min(5_000, ttl * 0.05) * this.random();
    } else {
      this.renewDue = Infinity;
    }
    this.apply(lease);
    this.arm();
  }

  private renewAt(): number {
    return this.renewDue;
  }

  private arm(retryMs?: number): void {
    this.timer?.();
    this.timer = null;
    if (this.closed || (retryMs === undefined && this.lease?.expiresAt === undefined)) return;
    const delay = retryMs ?? Math.max(100, this.renewAt() - this.scheduler.now());
    this.timer = this.scheduler.after(delay, () => {
      this.timer = null;
      void this.refresh();
    });
  }

  /** Single-flight para timer, volta da aba e recuperação do mesmo peer. */
  refresh(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.pending !== null) return this.pending;
    const operation = (async () => {
      try {
        const lease = await this.channel.refreshIce();
        if (this.closed) return false;
        if (lease.relayStatus === 'unavailable') {
          this.arm(5_000);
          return false;
        }
        this.use(lease);
        return true;
      } catch {
        if (!this.closed) this.arm(5_000);
        return false;
      }
    })();
    this.pending = operation.finally(() => { this.pending = null; });
    return this.pending;
  }

  async beforeRestart(): Promise<void> {
    if (this.lease?.relayStatus === 'not-configured') return;
    if (this.lease?.expiresAt === undefined || this.scheduler.now() >= this.renewAt()) {
      await this.refresh();
    }
  }

  close(): void {
    this.closed = true;
    this.timer?.();
    this.timer = null;
    this.visibility();
  }
}
