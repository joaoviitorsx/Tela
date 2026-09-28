import type { Cancel, Scheduler } from '../ports/scheduler.js';

export type PeerRecoveryDeps = {
  readonly scheduler: Scheduler;
  readonly beforeRestart: () => Promise<void>;
  /** Bytes de vídeo na PC atual; usados para respeitar mídia que ainda flui. */
  readonly mediaBytes?: () => Promise<number | null>;
  readonly restart: () => boolean;
  readonly rebuild: () => void;
  readonly onRecovering: () => void;
  readonly onRecovered: () => void;
  readonly onExhausted: () => void;
  readonly disconnectGraceMs?: number;
  readonly restartWaitMs?: number;
  readonly deadlineMs?: number;
};

/** Uma tentativa por peer: carência, restart, reconstrução, prazo final. */
export class PeerRecovery {
  private state: RTCPeerConnectionState = 'new';
  private active = false;
  private closed = false;
  private grace: Cancel | null = null;
  private rebuildTimer: Cancel | null = null;
  private deadline: Cancel | null = null;
  private lastBytes: number | null = null;

  constructor(private readonly deps: PeerRecoveryDeps) {}

  private isConnected(): boolean { return this.state === 'connected'; }

  private async mediaAdvanced(): Promise<boolean> {
    const current = await this.deps.mediaBytes?.() ?? null;
    const advanced = current !== null && this.lastBytes !== null && current > this.lastBytes;
    this.lastBytes = current;
    return advanced;
  }

  observe(state: RTCPeerConnectionState): void {
    if (this.closed) return;
    this.state = state;
    if (state === 'connected') {
      const recovered = this.active;
      this.clear();
      this.active = false;
      if (recovered) this.deps.onRecovered();
      return;
    }
    if (state === 'disconnected') {
      if (this.active || this.grace !== null) return;
      void this.mediaAdvanced();
      this.grace = this.deps.scheduler.after(this.deps.disconnectGraceMs ?? 3_000, () => {
        this.grace = null;
        void (async () => {
          const progressing = await this.mediaAdvanced();
          if (this.closed || this.state !== 'disconnected') return;
          if (progressing) this.observe('disconnected');
          else await this.begin();
        })();
      });
    } else if (state === 'failed' || state === 'closed') {
      this.grace?.();
      this.grace = null;
      void this.begin();
    }
  }

  private async begin(): Promise<void> {
    if (this.closed || this.active || this.isConnected()) return;
    this.active = true;
    this.deps.onRecovering();
    this.deadline = this.deps.scheduler.after(this.deps.deadlineMs ?? 30_000, () => {
      if (this.closed || !this.active) return;
      this.clear();
      this.active = false;
      this.deps.onExhausted();
    });
    try { await this.deps.beforeRestart(); } catch { /* tenta com ICE atual */ }
    if (this.closed || !this.active || this.isConnected()) return;
    if (this.state === 'closed' || !this.deps.restart()) {
      this.deps.rebuild();
      return;
    }
    this.rebuildTimer = this.deps.scheduler.after(this.deps.restartWaitMs ?? 10_000, () => {
      this.rebuildTimer = null;
      if (!this.closed && this.active && this.state !== 'connected') this.deps.rebuild();
    });
  }

  private clear(): void {
    this.grace?.();
    this.rebuildTimer?.();
    this.deadline?.();
    this.grace = this.rebuildTimer = this.deadline = null;
  }

  close(): void {
    this.closed = true;
    this.clear();
  }
}
