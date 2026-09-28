import type { ReactNode } from 'react';
import { Marca } from './Marca.js';

type Props = {
  readonly marcaHref?: string;
  /** À direita: pílula NO AR, diagnóstico, links. */
  readonly children?: ReactNode;
};

/**
 * A faixa de cima: marca, o que o produto é, e o que a tela precisa à direita.
 *
 * `role=banner` implícito do `<header>`. A frase "transmissão entre amigos"
 * some abaixo de `md`: em 390px cada pixel da faixa é do botão que importa.
 */
export function Cabecalho({ marcaHref, children }: Props) {
  return (
    <header className="flex min-h-14 items-center gap-3 border-b-2 border-line bg-bar px-4 sm:gap-4 sm:px-6">
      <div className="flex items-center gap-3">
        <Marca {...(marcaHref === undefined ? {} : { href: marcaHref })} />
        <span className="rotulo hidden md:inline">transmissão entre amigos</span>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}
