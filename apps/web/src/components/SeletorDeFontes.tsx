import { useId, type KeyboardEvent, type RefObject } from 'react';

export type TipoDeFonteNoSeletor = 'tela' | 'janela';
export type AbaDoSeletorDeFontes = 'janelas' | 'telas';

export type FonteNoSeletor = {
  readonly id: string;
  readonly nome: string;
  readonly tipo: TipoDeFonteNoSeletor;
  readonly miniatura: string | null;
  readonly icone: string | null;
};

type Props = {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly aoClicarNoFundo: (evento: React.MouseEvent<HTMLDialogElement>) => void;
  readonly aba: AbaDoSeletorDeFontes;
  readonly fontes: readonly FonteNoSeletor[];
  readonly carregando: boolean;
  /** Windows: janela não leva o som do sistema. A interface avisa antes, não depois. */
  readonly avisoDeJanela: string | null;
  /** Um jogo aberto que esconde o cursor em tela cheia (o LoL): vale para as duas abas. */
  readonly avisoDoJogo?: string | null;
  readonly aoMudarAba: (aba: AbaDoSeletorDeFontes) => void;
  readonly aoEscolher: (id: string) => void;
  readonly aoCancelar: () => void;
};

const ABAS: ReadonlyArray<{ readonly id: AbaDoSeletorDeFontes; readonly rotulo: string }> = [
  { id: 'janelas', rotulo: 'JOGO E JANELAS' },
  { id: 'telas', rotulo: 'TELAS' },
];

/**
 * O seletor de fontes do app (PLANO-desktop §11): a organização do modal
 * "Transmitir" do Discord — abas JOGO E JANELAS / TELAS e uma grade de
 * miniaturas — com a pele do site: `<dialog>` na moldura OSD, teclas com
 * relevo, rótulos em bitmap.
 *
 * Só desenho: as fontes, a aba e o que acontece ao escolher vêm por props
 * (`use-seletor-de-fontes.ts`). O `<dialog>` nativo entrega foco preso, `Esc`
 * e página inerte; as abas respondem a ←/→ e cada miniatura é um botão, então
 * Tab e Enter bastam para escolher sem mouse.
 */
export function SeletorDeFontes({
  dialogRef,
  aoClicarNoFundo,
  aba,
  fontes,
  carregando,
  avisoDeJanela,
  avisoDoJogo = null,
  aoMudarAba,
  aoEscolher,
  aoCancelar,
}: Props) {
  const idTitulo = useId();
  const visiveis = fontes.filter((f) => (aba === 'telas' ? f.tipo === 'tela' : f.tipo === 'janela'));

  const teclasDasAbas = (evento: KeyboardEvent<HTMLDivElement>) => {
    if (evento.key !== 'ArrowLeft' && evento.key !== 'ArrowRight') return;
    evento.preventDefault();
    const i = ABAS.findIndex((a) => a.id === aba);
    const proxima = ABAS[(i + (evento.key === 'ArrowRight' ? 1 : ABAS.length - 1)) % ABAS.length];
    if (proxima === undefined) return;
    aoMudarAba(proxima.id);
    (evento.currentTarget.querySelector(`[data-aba="${proxima.id}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={idTitulo}
      onClick={aoClicarNoFundo}
      className="m-auto max-h-[calc(100dvh-24px)] w-[min(960px,calc(100vw-24px))] overflow-auto border-2 border-edge bg-bar p-0 text-text shadow-[0_0_0_2px_#000,0_30px_80px_rgb(0_0_0_/_0.7)] backdrop:bg-black/75"
    >
      <div className="flex flex-col">
        <div className="titulo-osd sticky top-0 z-10 !min-h-11 !gap-0 !pl-4 !pr-0">
          <h2 id={idTitulo} className="m-0 flex-1 font-[inherit] text-[13px] font-bold">
            O QUE TRANSMITIR
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

        <div
          role="tablist"
          aria-label="Tipo de fonte"
          onKeyDown={teclasDasAbas}
          className="flex gap-1.5 border-b-2 border-line px-3.5 pt-3 pb-0"
        >
          {ABAS.map((a) => {
            const ativa = a.id === aba;
            return (
              <button
                key={a.id}
                type="button"
                role="tab"
                data-aba={a.id}
                aria-selected={ativa}
                aria-controls={`${idTitulo}-grade`}
                tabIndex={ativa ? 0 : -1}
                onClick={() => aoMudarAba(a.id)}
                className={[
                  'min-h-10 border-2 border-b-0 px-4 font-[family-name:var(--font-pixel)] text-[11px] transition-colors duration-150',
                  ativa
                    ? 'border-accent bg-accent text-ink'
                    : 'border-line bg-surface text-muted hover:border-accent-lo hover:text-accent-hi',
                ].join(' ')}
              >
                {a.rotulo}
              </button>
            );
          })}
        </div>

        {avisoDoJogo !== null && (
          <p role="note" className="m-0 border-b-2 border-warn-edge bg-warn-bg px-3.5 py-2 text-[11.5px] leading-relaxed text-warn">
            ! {avisoDoJogo}
          </p>
        )}

        {aba === 'janelas' && avisoDeJanela !== null && (
          <p className="m-0 border-b-2 border-warn-edge bg-warn-bg px-3.5 py-2 text-[11.5px] leading-relaxed text-warn">
            ! {avisoDeJanela}
          </p>
        )}

        <div
          id={`${idTitulo}-grade`}
          role="tabpanel"
          aria-busy={carregando}
          className="grid min-h-[200px] grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5 p-3.5"
        >
          {carregando && visiveis.length === 0 && (
            <p className="rotulo col-span-full m-0 self-center text-center">PROCURANDO…</p>
          )}
          {!carregando && visiveis.length === 0 && (
            <p className="rotulo col-span-full m-0 self-center text-center">
              {aba === 'telas' ? 'NENHUMA TELA ENCONTRADA' : 'NENHUMA JANELA ABERTA'}
            </p>
          )}
          {visiveis.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => aoEscolher(f.id)}
              // O nome acessível é o da fonte, não "SEM PRÉVIA Hades II".
              aria-label={f.nome}
              title={f.nome}
              className="group flex flex-col gap-1.5 border-2 border-line bg-surface p-1.5 text-left transition-colors duration-150 hover:border-accent-lo focus-visible:border-accent focus-visible:outline-none"
            >
              <span className="flex aspect-video w-full items-center justify-center overflow-hidden bg-deep">
                {f.miniatura === null ? (
                  <span className="rotulo">SEM PRÉVIA</span>
                ) : (
                  <img src={f.miniatura} alt="" className="h-full w-full object-contain" draggable={false} />
                )}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 px-0.5">
                {f.icone !== null && <img src={f.icone} alt="" className="h-4 w-4 shrink-0" draggable={false} />}
                <span className="truncate font-[family-name:var(--font-pixel)] text-[11px] text-text group-hover:text-accent-hi">
                  {f.nome}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </dialog>
  );
}
