import type { ReactNode } from 'react';
import { Marca } from './Marca.js';

type Props = {
  /** O que fica à direita da faixa. Uma coisa só — não é barra de navegação. */
  readonly children?: ReactNode;
  /** `grande` só na tela inicial, onde a marca se apresenta pela primeira vez. */
  readonly tamanho?: 'padrao' | 'grande';
};

/**
 * A faixa de identificação, na largura da janela.
 *
 * Era uma linha de 52px DENTRO de um cartão de 1180px, e o cartão era o
 * problema: uma chapa arredondada flutuando sobre o vazio faz o produto parecer
 * um formulário hospedado numa página, e não um aparelho. Agora as faixas
 * atravessam a janela de ponta a ponta e o que as separa são filetes de 1px —
 * o conteúdo é que respeita a coluna de 1180px, não a moldura.
 *
 * Continua sem menu, sem âncoras e sem "preços". O que existe à direita é a
 * ÚNICA outra página do produto (`/recuperar`), que sem isto não tem como ser
 * alcançada sem digitar o endereço na mão.
 *
 * Link de verdade, não botão com `pushState`: `/recuperar` é outra página, o
 * roteador lê `location.pathname` na carga, e uma navegação inteira aqui não
 * custa nada — não há sessão aberta na tela inicial para se perder.
 */
export function Masthead({ children, tamanho = 'padrao' }: Props) {
  return (
    <header data-vidro="preenchido" className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <Marca tamanho={tamanho} />
        {/*
          `ml-auto` só a partir de `sm`: a 360px a faixa quebra em duas linhas, e
          empurrar o link para a direita da segunda linha deixava um buraco no
          meio e o alvo de toque encostado na borda da tela.
        */}
        {children !== undefined && <span className="sm:ml-auto">{children}</span>}
      </div>
    </header>
  );
}
