import type { ReactNode } from 'react';

type Props = {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly tone?: 'accent' | 'danger' | 'ghost';
  readonly icon?: ReactNode;
};

const TONES = {
  accent: 'bg-accent text-void hover:brightness-110 active:brightness-95',
  danger: 'bg-danger text-void hover:brightness-110 active:brightness-95',
  ghost: 'border border-edge bg-surface text-text hover:border-text',
} as const;

/**
 * O único botão primário do produto.
 *
 * Altura mínima de 48px porque o alvo de toque precisa de 44px e o texto
 * precisa respirar. Transição em 180ms — dentro da faixa de 150–300ms em que
 * o movimento é percebido como resposta, e não como espera.
 */
export function BigButton({ children, onClick, disabled, busy, tone = 'accent', icon }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy}
      className={[
        'inline-flex min-h-12 items-center justify-center gap-2.5 rounded-md px-7',
        'text-[15px] font-semibold tracking-tight transition-all duration-[180ms]',
        'disabled:opacity-40 disabled:hover:brightness-100',
        TONES[tone],
      ].join(' ')}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
    />
  );
}
