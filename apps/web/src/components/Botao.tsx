import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  readonly tom?: 'padrao' | 'primaria' | 'perigo';
  /** A tecla grande do canal: 64px de altura, o maior alvo da tela. */
  readonly grande?: boolean;
  /** Ocupa a linha inteira. */
  readonly bloco?: boolean;
  readonly icone?: ReactNode;
};

const TOM = {
  padrao: 'tecla',
  primaria: 'tecla tecla-primaria',
  perigo: 'tecla tecla-perigo',
} as const;

/**
 * A tecla do aparelho. Todo botão do produto passa por aqui, para o relevo, o
 * anel de foco e o alvo de 44px terem um dono só.
 *
 * `type="button"` por padrão: nenhuma tecla envia formulário sem pedir.
 */
export function Botao({
  tom = 'padrao',
  grande = false,
  bloco = false,
  icone,
  type = 'button',
  children,
  ...resto
}: Props) {
  return (
    <button
      type={type}
      {...resto}
      className={[
        TOM[tom],
        grande ? 'min-h-16 gap-3.5 border-[3px] px-8 text-[18px] sm:text-[20px]' : '',
        bloco ? 'w-full' : '',
      ].join(' ')}
    >
      {icone}
      {children}
    </button>
  );
}

/** O link com a cara de tecla. Navegação de verdade: é `<a>`, não botão. */
export function LinkTecla({
  href,
  children,
  ...resto
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly download?: string;
}) {
  return (
    <a href={href} {...resto} className="tecla">
      {children}
    </a>
  );
}
