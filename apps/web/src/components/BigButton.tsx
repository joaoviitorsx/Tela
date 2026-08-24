import type { ReactNode } from 'react';

type Props = {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly tone?: 'accent' | 'danger' | 'ghost';
  readonly icon?: ReactNode;
  /** Ocupa a largura da coluna. Ver a nota sobre a tela inicial abaixo. */
  readonly bloco?: boolean;
};

const TONES = {
  accent: 'bg-accent text-void hover:brightness-110 active:brightness-95',
  danger: 'bg-danger text-void hover:brightness-110 active:brightness-95',
  ghost: 'border border-edge bg-void text-text hover:border-text',
} as const;

/**
 * O único botão primário do produto.
 *
 * Altura mínima de 48px porque o alvo de toque precisa de 44px e o texto
 * precisa respirar. Transição em 180ms — dentro da faixa de 150–300ms em que
 * o movimento é percebido como resposta, e não como espera.
 *
 * `bloco` existe porque a ADR 0008 §4 exige que o botão DOMINE a tela inicial,
 * e a régua disso mudou junto com o layout: num painel de duas colunas, um
 * botão de 190px encolhido ao lado de um campo de largura inteira já não
 * domina nada. Ocupando a coluna, ele volta a ser o maior alvo da página sem
 * precisar crescer de altura nem roubar o acento de mais nada.
 *
 * O tom `ghost` fica em `void`, não em `surface`: dentro da chapa (que é
 * `void`) o contorno `edge` mede 3,13:1, e sobre `surface` cairia para
 * 2,92:1 — abaixo do mínimo da WCAG 1.4.11 para o contorno de um controle.
 */
export function BigButton({
  children,
  onClick,
  disabled,
  busy,
  tone = 'accent',
  icon,
  bloco = false,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy}
      className={[
        'inline-flex items-center justify-center gap-2.5 rounded-md px-7',
        'font-semibold tracking-tight transition-all duration-[180ms]',
        'disabled:opacity-40 disabled:hover:brightness-100',
        bloco ? 'min-h-14 w-full text-[16px]' : 'min-h-12 text-[15px]',
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
