import { useId, type ReactNode } from 'react';

type Props = {
  readonly titulo: string;
  readonly dialogRef: React.RefObject<HTMLDialogElement | null>;
  readonly aoClicar: (evento: React.MouseEvent<HTMLDialogElement>) => void;
  readonly aoFechar: () => void;
  readonly children: ReactNode;
  /** Conteúdo de uma coluna só: 560px em vez de 1040px. */
  readonly estreito?: boolean;
};

/**
 * A janela por cima da tela. É um `<dialog>` nativo: foco preso, `Esc` e
 * página inerte vêm do navegador (`useDialogo` só o liga ao estado).
 *
 * Sem `display` no `<dialog>` de propósito — qualquer classe `flex` aqui
 * vence o `display: none` do agente de usuário e o modal fecha "aberto".
 * O layout mora no `div` de dentro.
 */
export function Dialogo({ titulo, dialogRef, aoClicar, aoFechar, children, estreito = false }: Props) {
  const id = useId();
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={id}
      onClick={aoClicar}
      className={`m-auto max-h-[calc(100dvh-24px)] ${estreito ? 'w-[min(560px,calc(100vw-24px))]' : 'w-[min(1040px,calc(100vw-24px))]'} overflow-auto border-2 border-edge bg-bar p-0 text-text shadow-[0_0_0_2px_#000,0_30px_80px_rgb(0_0_0_/_0.7)] backdrop:bg-black/75`}
    >
      <div className="flex flex-col">
        <div className="titulo-osd sticky top-0 z-10 !min-h-11 !gap-0 !pl-4 !pr-0">
          <h2 id={id} className="m-0 flex-1 font-[inherit] text-[13px] font-bold">
            {titulo}
          </h2>
          <button
            type="button"
            onClick={aoFechar}
            aria-label="Fechar"
            className="flex h-11 w-11 items-center justify-center border-0 bg-ink font-[family-name:var(--font-pixel)] text-[18px] leading-none text-accent hover:bg-key"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
