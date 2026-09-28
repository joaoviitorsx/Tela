import { useId, type ReactNode } from 'react';

type Props = {
  /** "MENU ▸ IMAGEM": o caminho, como no menu de um televisor. */
  readonly titulo: string;
  /** À direita da barra de título: a posição "2/3", uma contagem. */
  readonly direita?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
};

/**
 * O painel do menu: barra de título âmbar e corpo grafite.
 *
 * É uma região nomeada (`aria-labelledby` no título), então quem navega por
 * regiões com leitor de tela sabe em qual "menu" está.
 */
export function PainelOsd({ titulo, direita, children, className = '' }: Props) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`painel flex min-w-0 flex-col ${className}`}>
      <div className="titulo-osd">
        <h2 id={id} className="m-0 font-[inherit] text-[12px] font-bold">
          {titulo}
        </h2>
        <div className="flex-1" />
        {direita !== undefined && <span className="text-[11px] font-normal">{direita}</span>}
      </div>
      {children}
    </section>
  );
}
