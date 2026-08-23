import type { Storage } from '../core/ports/storage.js';

/**
 * `localStorage` pode lançar: aba anônima com cookies bloqueados, cota cheia,
 * política corporativa. Perder o slug é ruim; a página quebrar é pior — daí
 * o fallback em memória.
 */
export function makeLocalStorage(): Storage {
  const memory = new Map<string, string>();

  const available = (() => {
    try {
      const probe = '__tela__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  })();

  if (!available) {
    return {
      get: (key) => memory.get(key) ?? null,
      set: (key, value) => void memory.set(key, value),
      remove: (key) => void memory.delete(key),
    };
  }

  return {
    get: (key) => window.localStorage.getItem(key),
    set: (key, value) => window.localStorage.setItem(key, value),
    remove: (key) => window.localStorage.removeItem(key),
  };
}
