import { useId, type ReactNode, type RefObject } from 'react';
import { Botao } from './Botao.js';

type Props = {
  readonly titulo: string;
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly aoClicarNoFundo: (evento: React.MouseEvent<HTMLDialogElement>) => void;
  /** O corpo: o que vai acontecer, em uma ou duas frases. */
  readonly children: ReactNode;
  /** A saída segura. Recebe o foco ao abrir: Enter sem querer não destrói nada. */
  readonly rotuloSeguro: string;
  readonly seguroRef: RefObject<HTMLButtonElement | null>;
  readonly aoSeguro: () => void;
  /** A ação que não desfaz, em tom de perigo. */
  readonly rotuloAcao: string;
  readonly aoAcao: () => void;
};

/**
 * A confirmação do Tela, no lugar do `window.confirm` do navegador (C-03).
 *
 * É um `<dialog>` nativo (foco preso, `Esc`, fundo inerte), com a identidade do
 * produto e a ordem certa das teclas: a segura primeiro e com o foco, a
 * destrutiva depois. `Esc` e o clique no fundo contam como a saída segura.
 *
 * Sem `display` no `<dialog>`, pelo mesmo motivo de `Dialogo`: uma classe
 * `flex` aqui abriria o modal "aberto" o tempo todo.
 */
export function DialogoConfirmar({
  titulo,
  dialogRef,
  aoClicarNoFundo,
  children,
  rotuloSeguro,
  seguroRef,
  aoSeguro,
  rotuloAcao,
  aoAcao,
}: Props) {
  const idTitulo = useId();
  const idCorpo = useId();
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={idTitulo}
      aria-describedby={idCorpo}
      onClick={aoClicarNoFundo}
      className="m-auto w-[min(460px,calc(100vw-24px))] border-2 border-edge bg-bar p-0 text-text shadow-[0_0_0_2px_#000,0_30px_80px_rgb(0_0_0_/_0.7)] backdrop:bg-black/75"
    >
      <div className="flex flex-col">
        <div className="titulo-osd !min-h-11">
          <h2 id={idTitulo} className="m-0 font-[inherit] text-[13px] font-bold">
            {titulo}
          </h2>
        </div>
        <p id={idCorpo} className="m-0 px-4 py-5 text-[13px] leading-relaxed text-text [text-wrap:pretty]">
          {children}
        </p>
        <div className="flex flex-col-reverse gap-2 border-t-2 border-line p-3.5 sm:flex-row sm:justify-end">
          <Botao tom="perigo" onClick={aoAcao}>
            {rotuloAcao}
          </Botao>
          <button ref={seguroRef} type="button" onClick={aoSeguro} className="tecla tecla-primaria">
            {rotuloSeguro}
          </button>
        </div>
      </div>
    </dialog>
  );
}
