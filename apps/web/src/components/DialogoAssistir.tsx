import { useId, type RefObject } from 'react';
import { Botao } from './Botao.js';

type Props = {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly aoClicarNoFundo: (evento: React.MouseEvent<HTMLDialogElement>) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly valor: string;
  readonly aoMudar: (valor: string) => void;
  /** `true` depois de um envio que não virou canal: a frase explica o que colar. */
  readonly invalido: boolean;
  readonly aoEnviar: () => void;
  readonly aoCancelar: () => void;
};

/**
 * O painel ASSISTIR do app (PLANO-desktop §14): cola o link do convite, ou o
 * nome do canal, e a rota do espectador abre. Um campo e uma tecla — quem está
 * na call só quer entrar.
 *
 * `<dialog>` nativo, como o seletor de fontes: foco preso, `Esc` e página
 * inerte vêm do navegador. A validação é de quem usa (`canalDaEntrada`); isto
 * só desenha o resultado.
 */
export function DialogoAssistir({
  dialogRef,
  aoClicarNoFundo,
  inputRef,
  valor,
  aoMudar,
  invalido,
  aoEnviar,
  aoCancelar,
}: Props) {
  const idTitulo = useId();
  const idCampo = useId();
  const idAjuda = useId();
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={idTitulo}
      onClick={aoClicarNoFundo}
      className="m-auto max-h-[calc(100dvh-24px)] w-[min(560px,calc(100vw-24px))] overflow-auto border-2 border-edge bg-bar p-0 text-text shadow-[0_0_0_2px_#000,0_30px_80px_rgb(0_0_0_/_0.7)] backdrop:bg-black/75"
    >
      <form
        onSubmit={(evento) => {
          evento.preventDefault();
          aoEnviar();
        }}
        className="flex flex-col"
      >
        <div className="titulo-osd !min-h-11 !gap-0 !pl-4 !pr-0">
          <h2 id={idTitulo} className="m-0 flex-1 font-[inherit] text-[13px] font-bold">
            ASSISTIR UM CANAL
          </h2>
          <button
            type="button"
            onClick={aoCancelar}
            aria-label="Cancelar"
            className="flex h-11 w-11 items-center justify-center border-0 bg-ink font-[family-name:var(--font-pixel)] text-[18px] leading-none text-accent hover:bg-key"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-3 p-4">
          <label htmlFor={idCampo} className="rotulo">
            LINK OU NOME DO CANAL
          </label>
          <input
            ref={inputRef}
            id={idCampo}
            value={valor}
            onChange={(e) => aoMudar(e.target.value)}
            placeholder="tela.gg/seucanal"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby={idAjuda}
            aria-invalid={invalido}
            className={[
              'min-h-12 border-2 bg-deep px-3 font-[family-name:var(--font-pixel)] text-[14px] text-accent-hi outline-none placeholder:text-faint focus:border-accent',
              invalido ? 'border-danger-edge' : 'border-edge',
            ].join(' ')}
          />
          <p
            id={idAjuda}
            role="status"
            className={`m-0 text-[12px] leading-relaxed ${invalido ? 'text-warn' : 'text-muted'}`}
          >
            {invalido
              ? '! Não achei um canal aí. Cole o link do convite ou digite só o nome (3 a 25 letras, números e hífen).'
              : 'Cole o link que mandaram na call, ou digite o nome do canal.'}
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Botao onClick={aoCancelar}>CANCELAR</Botao>
            <Botao type="submit" tom="primaria">
              ASSISTIR
            </Botao>
          </div>
        </div>
      </form>
    </dialog>
  );
}
