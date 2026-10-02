export type Retangulo = { readonly bottom: number; readonly right: number };

/** Folga entre o botão e o painel, e margem mínima até a borda da janela. */
const FOLGA = 4;
const MARGEM = 8;

/**
 * Onde pôr um painel de topo (`position: fixed`) embaixo de um botão, com a
 * borda direita alinhada à do botão. `direita` é a distância até a borda
 * direita da janela, nunca menor que a margem: assim o painel não vaza para
 * fora da tela quando o botão está colado na lateral.
 */
export function posicaoDoPopover(
  ancora: Retangulo,
  larguraDaJanela: number,
): { readonly topo: number; readonly direita: number } {
  return {
    topo: Math.round(ancora.bottom + FOLGA),
    direita: Math.max(MARGEM, Math.round(larguraDaJanela - ancora.right)),
  };
}
