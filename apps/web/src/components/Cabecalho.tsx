import type { ReactNode } from 'react';
import { Marca } from './Marca.js';

type Props = {
  readonly marcaHref?: string;
  /** À direita: pílula NO AR, diagnóstico, links. */
  readonly children?: ReactNode;
};

/**
 * A faixa de cima: a marca, e o que a tela precisa à direita.
 *
 * `role=banner` implícito do `<header>`.
 */
export function Cabecalho({ marcaHref, children }: Props) {
  return (
    <header className="flex min-h-14 items-center gap-3 border-b-2 border-line bg-bar px-4 sm:gap-4 sm:px-6">
      <Marca {...(marcaHref === undefined ? {} : { href: marcaHref })} />
      <div className="flex-1" />
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}
