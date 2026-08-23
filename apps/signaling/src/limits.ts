/**
 * Limites do servidor de sinalização. Todos em um lugar, todos configuráveis
 * por env, todos com um motivo escrito.
 */
export type Limits = {
  /** Espectadores por canal. Em mesh o teto é a CPU e o upload do transmissor. */
  readonly maxPeers: number;
  /** Mensagens por conexão, por janela. */
  readonly messageLimit: number;
  readonly messageWindowMs: number;
  /** Tentativas de `host` por IP, por janela. Barra squatting em massa. */
  readonly hostLimit: number;
  readonly hostWindowMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxPeers: 3,
  messageLimit: 30,
  messageWindowMs: 10_000,
  hostLimit: 5,
  hostWindowMs: 60_000,
};

/**
 * Balde de fichas por janela fixa, em memória.
 *
 * A varredura é preguiçosa e no máximo uma por janela: só o teto de tamanho
 * faria a limpeza O(n) rodar em toda mensagem sob carga, que é exatamente
 * quando ela não pode custar nada.
 */
export class RateBuckets {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweepAt = 0;

  constructor(
    private readonly now: () => number,
    private readonly sweepThreshold = 10_000,
    private readonly sweepIntervalMs = 60_000,
  ) {}

  /** `true` quando a ação é permitida. */
  take(key: string, limit: number, windowMs: number): boolean {
    const now = this.now();
    this.sweep(now);

    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }

  private sweep(now: number): void {
    if (this.buckets.size < this.sweepThreshold) return;
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
