import type { ReactNode } from 'react';
import { IconGithub } from './Icon.js';
import { Marca } from './Marca.js';

type Props = {
  readonly marcaHref?: string;
  /** O código-fonte: sem URL, sem ícone. */
  readonly repositorio?: string;
  /** À direita: pílula NO AR, diagnóstico, links. */
  readonly children?: ReactNode;
};

/**
 * A faixa de cima: a marca, e o que a tela precisa à direita.
 *
 * `role=banner` implícito do `<header>`.
 */
export function Cabecalho({ marcaHref, repositorio, children }: Props) {
  return (
    <header className="flex min-h-14 items-center gap-3 border-b-2 border-line bg-bar px-4 sm:gap-4 sm:px-6">
      <Marca {...(marcaHref === undefined ? {} : { href: marcaHref })} />
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        {children}
        {repositorio !== undefined && (
          // Só com folga: abaixo de `lg` a faixa já está cheia e o link transbordava (W-04).
          <a
            href={repositorio}
            target="_blank"
            rel="noopener noreferrer"
            className="tecla hidden lg:inline-flex"
            title="Código no GitHub"
          >
            <IconGithub className="h-3.5 w-3.5" />
            <span className="sr-only">Código no GitHub</span>
          </a>
        )}
      </div>
    </header>
  );
}
