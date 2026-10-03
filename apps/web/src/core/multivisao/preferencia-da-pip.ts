import type { Storage } from '../ports/storage.js';
import { type Canto, PIP_PADRAO, type PreferenciaDaPip, type TamanhoPip } from './estado.js';

export const PIP_KEY = 'tela.multivisao.pip';

const CANTOS: ReadonlySet<string> = new Set<Canto>(['inf-dir', 'inf-esq', 'sup-dir', 'sup-esq']);
const TAMANHOS: ReadonlySet<string> = new Set<TamanhoPip>(['p', 'm', 'g']);

export type PreferenciaDaPipStore = {
  ler(): PreferenciaDaPip;
  gravar(p: PreferenciaDaPip): void;
};

/**
 * Onde a pessoa deixou o quadro e de que tamanho. Cada jogo põe o HUD num
 * canto, e quem assiste o mesmo amigo sempre não quer arrastar toda vez.
 */
export function makePreferenciaDaPip(storage: Storage): PreferenciaDaPipStore {
  return {
    ler() {
      try {
        const bruto: unknown = JSON.parse(storage.get(PIP_KEY) ?? 'null');
        if (typeof bruto !== 'object' || bruto === null) return PIP_PADRAO;
        const { canto, tamanho } = bruto as Record<string, unknown>;
        return {
          canto: typeof canto === 'string' && CANTOS.has(canto) ? (canto as Canto) : PIP_PADRAO.canto,
          tamanho: typeof tamanho === 'string' && TAMANHOS.has(tamanho) ? (tamanho as TamanhoPip) : PIP_PADRAO.tamanho,
        };
      } catch {
        return PIP_PADRAO;
      }
    },
    gravar(p) {
      storage.set(PIP_KEY, JSON.stringify({ canto: p.canto, tamanho: p.tamanho }));
    },
  };
}
