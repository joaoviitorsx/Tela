import type { ReactNode } from 'react';

type Props = {
  /** O que fica à direita da faixa. Uma coisa só — não é barra de navegação. */
  readonly children?: ReactNode;
};

/**
 * A faixa de identificação, na largura do painel.
 *
 * A tela inicial não tinha nenhuma: era um botão flutuando no vazio, e o
 * produto não se apresentava. Isto é uma linha de 44px, não um cabeçalho de
 * site — sem menu, sem âncoras, sem "preços". O que existe à direita é a
 * ÚNICA outra página do produto (`/recuperar`), que hoje não tem como ser
 * alcançada sem digitar o endereço na mão.
 *
 * Ela teve um subtítulo — "1080p60 · direto do seu PC · sem cadastro" — e ele
 * saiu. Os mesmos três fatos apareciam logo abaixo em duas outras regiões da
 * mesma chapa: na coluna que explica por que o produto existe e no caminho do
 * vídeo, este com os números de verdade. Dizer a mesma coisa três vezes numa
 * tela obriga quem lê a conferir se são a mesma coisa. Ficou o nome; a faixa
 * de um aparelho é isso mesmo.
 *
 * Link de verdade, não botão com `pushState`: `/recuperar` é outra página, o
 * roteador lê `location.pathname` na carga, e uma navegação inteira aqui não
 * custa nada — não há sessão aberta na tela inicial para se perder.
 */
export function Masthead({ children }: Props) {
  return (
    <header className="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-4 py-2.5 sm:px-6">
      <span className="text-[15px] font-semibold tracking-tight text-text">tela</span>
      {/*
        `ml-auto` só a partir de `sm`: a 360px a faixa quebra em duas linhas, e
        empurrar o link para a direita da segunda linha deixava um buraco no
        meio e o alvo de toque encostado na borda da tela.
      */}
      {children !== undefined && <span className="sm:ml-auto">{children}</span>}
    </header>
  );
}
