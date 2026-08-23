/**
 * Emissor tipado mínimo. Existe para que as sessões possam notificar mudança
 * sem conhecer React — `useSyncExternalStore` assina isto do lado de fora.
 */
export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<never>);
    this.listeners.set(event, set);
    return () => {
      set.delete(listener as Listener<never>);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Cópia: um listener que se remove durante o emit não pode corromper a iteração.
    for (const listener of [...set]) (listener as Listener<Events[K]>)(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
