import { DICA_DO_MENU_OSD } from './dica-do-menu-osd.js';

export type AbaDeResolucao = { readonly id: string; readonly rotulo: string };

type Props = {
  readonly opcoes: readonly AbaDeResolucao[];
  /** O que a pessoa escolheu: a aba acesa. */
  readonly escolhido: string;
  /** O que está no ar, quando a rede ou a CPU seguram abaixo do escolhido. */
  readonly noAr: string | null;
  readonly ajuda: string;
  readonly aoEscolher: (id: string) => void;
  /** Foco e ←→ vêm do menu OSD, como as outras linhas do ajuste rápido. */
  readonly propsGrupo: {
    readonly ref: (el: HTMLElement | null) => void;
    readonly tabIndex: 0 | -1;
    readonly 'data-linha': string;
    readonly onFocus: () => void;
  };
};

/**
 * A resolução ao vivo, à vista.
 *
 * Era uma linha de menu com setas (`◀ 1080P60 ▶`), e ninguém achava. Aqui as
 * seis ficam na tela, a escolhida acesa. Quando o link ou a máquina seguram
 * abaixo dela, a aba do que de fato está saindo ganha "NO AR" — o rótulo não
 * pode prometer o que a imagem não entrega (ADR 0015).
 */
export function AbasDeResolucao({ opcoes, escolhido, noAr, ajuda, aoEscolher, propsGrupo }: Props) {
  return (
    <div className="flex flex-col gap-2 border-b-2 border-line px-3.5 pb-3 pt-3">
      <span className="rotulo">RESOLUÇÃO</span>
      <span id="dica-menu-osd-abas" className="sr-only">
        {DICA_DO_MENU_OSD}
      </span>
      <div
        {...propsGrupo}
        role="radiogroup"
        aria-label="Resolução"
        aria-describedby="ajuda-resolucao-ao-vivo dica-menu-osd-abas"
        className="grid grid-cols-3 gap-1.5 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {opcoes.map((o) => {
          const marcado = o.id === escolhido;
          const saindo = noAr === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={marcado}
              tabIndex={-1}
              onClick={() => aoEscolher(o.id)}
              className={[
                'flex min-h-11 flex-col items-center justify-center gap-0.5 border-2 px-1 font-[family-name:var(--font-pixel)] text-[11px] transition-colors duration-150',
                marcado
                  ? 'border-accent bg-accent text-ink shadow-[0_0_14px_rgb(242_169_59_/_0.3)]'
                  : saindo
                    ? 'border-warn text-warn'
                    : 'border-edge-key bg-surface text-text hover:border-accent-lo hover:text-accent-hi',
              ].join(' ')}
            >
              {o.rotulo}
              {saindo && <span className="text-[9px]">NO AR</span>}
            </button>
          );
        })}
      </div>
      <p id="ajuda-resolucao-ao-vivo" className="m-0 text-[11.5px] leading-relaxed text-muted [text-wrap:pretty]">
        {ajuda}
      </p>
    </div>
  );
}
