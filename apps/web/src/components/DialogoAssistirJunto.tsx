import { useId, type RefObject } from 'react';
import { Botao } from './Botao.js';

type Props = {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly aoClicarNoFundo: (evento: React.MouseEvent<HTMLDialogElement>) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly valor: string;
  readonly aoMudar: (valor: string) => void;
  /** Depois de um envio que não deu: a frase explica o porquê. */
  readonly erro: 'invalido' | 'repetido' | null;
  /** Canais já vistos neste aparelho, sem os que estão na tela. */
  readonly recentes: readonly string[];
  readonly aoEscolher: (canal: string) => void;
  /** Com duas telas abertas, quem sai para a nova entrar. */
  readonly substitui: string | null;
  readonly aoEnviar: () => void;
  readonly aoCancelar: () => void;
};

const AJUDA = {
  invalido: '! Não achei um canal aí. Cole o link ou digite só o nome (3 a 25 letras, números e hífen).',
  repetido: '! Esse canal já está na tela.',
} as const;

/**
 * "+ TELA": pôr outro canal ao lado do que está passando (ADR 0032). O
 * mesmo campo do ASSISTIR do app, mais os canais recentes como teclas — quem
 * assiste os mesmos amigos toda noite não deveria digitar.
 */
export function DialogoAssistirJunto({
  dialogRef,
  aoClicarNoFundo,
  inputRef,
  valor,
  aoMudar,
  erro,
  recentes,
  aoEscolher,
  substitui,
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
            + TELA · ASSISTIR JUNTO
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
          {recentes.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="rotulo">RECENTES</span>
              <div className="flex flex-wrap gap-2">
                {recentes.map((canal) => (
                  <button key={canal} type="button" onClick={() => aoEscolher(canal)} className="tecla">
                    {canal}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label htmlFor={idCampo} className="rotulo">
            LINK OU NOME DO CANAL
          </label>
          <input
            ref={inputRef}
            id={idCampo}
            value={valor}
            onChange={(e) => aoMudar(e.target.value)}
            placeholder="tela.gg/seuamigo"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby={idAjuda}
            aria-invalid={erro !== null}
            className={[
              'min-h-12 border-2 bg-deep px-3 font-[family-name:var(--font-pixel)] text-[14px] text-accent-hi outline-none placeholder:text-faint focus:border-accent',
              erro !== null ? 'border-danger-edge' : 'border-edge',
            ].join(' ')}
          />
          <p
            id={idAjuda}
            role="status"
            className={`m-0 text-[12px] leading-relaxed ${erro !== null ? 'text-warn' : 'text-muted'}`}
          >
            {erro !== null
              ? AJUDA[erro]
              : substitui !== null
                ? `O novo canal entra no lugar de ${substitui}.`
                : 'Ele abre num quadro no canto. Clique no quadro para trocar qual fica grande.'}
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Botao onClick={aoCancelar}>CANCELAR</Botao>
            <Botao type="submit" tom="primaria">
              ADICIONAR
            </Botao>
          </div>
        </div>
      </form>
    </dialog>
  );
}
