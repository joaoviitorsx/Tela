import type { CSSProperties } from 'react';
import type { Canto, Layout, TamanhoPip } from '../core/multivisao/estado.js';

/**
 * Onde cada painel fica no palco (ADR 0032). Classe e estilo, e mais nada:
 * trocar a principal é trocar ISTO, nunca o elemento.
 *
 * - `sozinho`: um canal, tela inteira — o espectador de sempre.
 * - `pip`: a principal na tela inteira, a secundária num quadro no canto.
 * - `lado-a-lado` e `empilhado`: metade cada, NA ORDEM DOS CANAIS. Trocar ali
 *   não move nada; só a borda âmbar (e o som) muda de lado.
 */
export type Arranjo = 'sozinho' | Layout | 'empilhado';

export type PosicaoDoPainel = { readonly classe: string; readonly estilo: CSSProperties };

/** Largura do quadro: fração do palco, com piso e teto em px. */
const LARGURA: Readonly<Record<TamanhoPip, string>> = {
  p: 'clamp(150px, 18%, 360px)',
  m: 'clamp(180px, 24%, 480px)',
  g: 'clamp(220px, 34%, 680px)',
};

const CANTO: Readonly<Record<Canto, string>> = {
  'inf-dir': 'bottom-3 right-3 sm:bottom-5 sm:right-5',
  'inf-esq': 'bottom-3 left-3 sm:bottom-5 sm:left-5',
  'sup-dir': 'right-3 top-3 sm:right-5 sm:top-5',
  'sup-esq': 'left-3 top-3 sm:left-5 sm:top-5',
};

/**
 * A secundária é imagem do jogo: fica acima do vidro do CRT (z 40), como
 * tudo que é `acima-do-crt` (z 41) — vídeo nunca leva listras.
 */
const ACIMA_DO_CRT = 'z-[41]';

export function posicaoDoPainel(o: {
  readonly arranjo: Arranjo;
  readonly principal: boolean;
  /** A posição do canal na lista (estável): decide a metade em lado a lado e empilhado. */
  readonly indice: number;
  readonly canto: Canto;
  readonly tamanho: TamanhoPip;
  /** Quanto a barra de baixo ocupa agora, em px; 0 quando escondida. */
  readonly folgaDaBarra: number;
}): PosicaoDoPainel {
  const camada = o.principal ? '' : ACIMA_DO_CRT;
  switch (o.arranjo) {
    case 'sozinho':
      return { classe: 'absolute inset-0', estilo: {} };
    case 'lado-a-lado':
      return {
        classe: `absolute inset-y-0 w-1/2 ${o.indice === 0 ? 'left-0' : 'right-0'} ${camada}`,
        estilo: {},
      };
    case 'empilhado':
      return {
        classe: `absolute inset-x-0 h-1/2 ${o.indice === 0 ? 'top-0' : 'bottom-0'} ${camada}`,
        estilo: {},
      };
    case 'pip': {
      if (o.principal) return { classe: 'absolute inset-0', estilo: {} };
      const embaixo = o.canto.startsWith('inf');
      return {
        classe: `absolute aspect-video ${CANTO[o.canto]} ${camada}`,
        estilo: {
          width: LARGURA[o.tamanho],
          // `translate`, e não `transform`: o `transform` é da animação da troca.
          translate: embaixo && o.folgaDaBarra > 0 ? `0 -${o.folgaDaBarra}px` : '0 0',
          transition: 'translate 300ms ease-out',
        },
      };
    }
  }
}
