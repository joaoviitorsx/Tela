import { SLUG_RE } from '@tela/shared';
import type { Storage } from '../ports/storage.js';

/**
 * Os canais que este aparelho assistiu por último, para o `+ TELA` oferecer
 * com um toque (ADR 0032). Ficam só no navegador — o servidor não sabe quem
 * assiste o quê, e não vai passar a saber.
 */
export const RECENTES_KEY = 'tela.recentes';
export const MAX_RECENTES = 6;

export type CanaisRecentes = {
  listar(): readonly string[];
  lembrar(canal: string): void;
};

export function makeCanaisRecentes(storage: Storage): CanaisRecentes {
  const listar = (): readonly string[] => {
    const bruto = storage.get(RECENTES_KEY);
    if (bruto === null) return [];
    try {
      const lista: unknown = JSON.parse(bruto);
      if (!Array.isArray(lista)) return [];
      return lista.filter((c): c is string => typeof c === 'string' && SLUG_RE.test(c)).slice(0, MAX_RECENTES);
    } catch {
      return [];
    }
  };
  return {
    listar,
    lembrar(canal) {
      if (!SLUG_RE.test(canal)) return;
      const lista = [canal, ...listar().filter((c) => c !== canal)].slice(0, MAX_RECENTES);
      storage.set(RECENTES_KEY, JSON.stringify(lista));
    },
  };
}
