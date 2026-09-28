import type { ReactNode } from 'react';

type Props = {
  readonly children: ReactNode;
  /** `alerta` = acontece agora e pede ação. `nota` = orientação. */
  readonly tom?: 'alerta' | 'nota';
  /** `status` para o que aparece durante o uso; ausente para orientação fixa. */
  readonly anuncia?: boolean;
};

/**
 * A caixa de aviso: "!" bitmap e uma frase.
 *
 * O "!" faz o papel que a cor não pode fazer sozinha — âmbar é também a cor do
 * botão primário, então o que distingue um aviso é o glifo e a moldura, e o
 * texto sempre diz o que aconteceu.
 */
export function Aviso({ children, tom = 'nota', anuncia = false }: Props) {
  return (
    <div
      {...(anuncia ? { role: 'status' as const } : {})}
      className={[
        'flex items-start gap-3 border-2 px-3.5 py-3',
        tom === 'alerta'
          ? 'border-warn-edge bg-warn-bg'
          : 'border-line bg-surface',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'font-[family-name:var(--font-pixel)] text-[13px] leading-[1.6]',
          tom === 'alerta' ? 'text-accent' : 'text-dim',
        ].join(' ')}
      >
        !
      </span>
      <div
        className={[
          'min-w-0 text-[12px] leading-relaxed [text-wrap:pretty]',
          tom === 'alerta' ? 'text-warn' : 'text-muted',
        ].join(' ')}
      >
        {children}
      </div>
    </div>
  );
}
