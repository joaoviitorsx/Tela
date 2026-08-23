/**
 * Mapa com TTL por chave, sem timer.
 *
 * A expiração é verificada na leitura (lazy). Isso evita um `setTimeout` por
 * chave — num host doméstico com um punhado de slugs isso é irrelevante em
 * memória e evita segurar o event loop.
 */
export class ExpiringMap<V> {
  private readonly rows = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly now: () => number) {}

  set(key: string, value: V, ttlSeconds: number): void {
    this.rows.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  get(key: string): V | null {
    const row = this.rows.get(key);
    if (!row) return null;
    if (row.expiresAt <= this.now()) {
      this.rows.delete(key);
      return null;
    }
    return row.value;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** Só renova o que ainda está vivo — equivalente a `EXPIRE ... XX`. */
  touch(key: string, ttlSeconds: number): boolean {
    const row = this.rows.get(key);
    if (!row || row.expiresAt <= this.now()) {
      this.rows.delete(key);
      return false;
    }
    row.expiresAt = this.now() + ttlSeconds * 1000;
    return true;
  }

  delete(key: string): void {
    this.rows.delete(key);
  }

  get size(): number {
    let alive = 0;
    for (const key of [...this.rows.keys()]) if (this.get(key) !== null) alive += 1;
    return alive;
  }
}
