import { type RefObject, useId } from 'react';

type Props = {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly aoClicarNoFundo: (evento: React.MouseEvent<HTMLDialogElement>) => void;
  /** Há bandeja? Muda para onde a transmissão vai e como se controla. */
  readonly bandeja: boolean;
  readonly lembrar: boolean;
  readonly aoMudarLembrar: (valor: boolean) => void;
  readonly continuarRef: RefObject<HTMLButtonElement | null>;
  readonly aoContinuar: () => void;
  readonly aoEncerrar: () => void;
};

/**
 * "Continuar transmitindo em segundo plano?" — a pergunta de fechar a janela ao
 * vivo (D4). A saída segura (e com o foco) é CONTINUAR: Enter sem querer não
 * derruba a transmissão. `Esc` e o clique no fundo CANCELAM o fechar, e a
 * janela fica como está — por isso não há um terceiro botão para isso.
 */
export function DialogoFechar({
  dialogRef,
  aoClicarNoFundo,
  bandeja,
  lembrar,
  aoMudarLembrar,
  continuarRef,
  aoContinuar,
  aoEncerrar,
}: Props) {
  const idTitulo = useId();
  const idCorpo = useId();
  const idLembrar = useId();
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={idTitulo}
      aria-describedby={idCorpo}
      onClick={aoClicarNoFundo}
      className="m-auto w-[min(500px,calc(100vw-24px))] border-2 border-edge bg-bar p-0 text-text shadow-[0_0_0_2px_#000,0_30px_80px_rgb(0_0_0_/_0.7)] backdrop:bg-black/75"
    >
      <div className="flex flex-col">
        <div className="titulo-osd !min-h-11">
          <h2 id={idTitulo} className="m-0 font-[inherit] text-[13px] font-bold">
            CONTINUAR TRANSMITINDO EM SEGUNDO PLANO?
          </h2>
        </div>
        <div id={idCorpo} className="flex flex-col gap-3 px-4 py-5 text-[13px] leading-relaxed [text-wrap:pretty]">
          <p className="m-0">
            Você está ao vivo. Fechar a janela não precisa derrubar a transmissão:
            {bandeja
              ? ' ela segue no ar e você a controla pelo ícone do Tela na bandeja do sistema.'
              : ' este sistema não tem ícone de bandeja, então a janela vira uma faixa compacta, sempre à mão.'}
          </p>
          <label htmlFor={idLembrar} className="flex items-center gap-2.5 text-[12px] text-dim">
            <input
              id={idLembrar}
              type="checkbox"
              checked={lembrar}
              onChange={(e) => aoMudarLembrar(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            Lembrar minha escolha (dá para mudar em AJUSTES)
          </label>
        </div>
        <div className="flex flex-col-reverse gap-2 border-t-2 border-line p-3.5 sm:flex-row sm:justify-end">
          <button type="button" onClick={aoEncerrar} className="tecla tecla-perigo">
            ENCERRAR E SAIR
          </button>
          <button ref={continuarRef} type="button" onClick={aoContinuar} className="tecla tecla-primaria">
            CONTINUAR NO AR
          </button>
        </div>
      </div>
    </dialog>
  );
}
