import { Medidor } from './Medidor.js';

export type OpcaoDeResolucao = {
  readonly id: string;
  readonly rotulo: string;
  readonly largura: number;
  readonly altura: number;
  readonly fps: number;
  /** Subida nominal por espectador, em Mbps, já formatada. */
  readonly mbps: string;
};

type Props = {
  readonly opcoes: readonly OpcaoDeResolucao[];
  readonly escolhido: string;
  /** O degrau que a última transmissão sustentou, se houver. */
  readonly sustentavel: string | null;
  readonly ajuda: string;
  readonly aoEscolher: (id: string) => void;
  /** Foco e teclas vêm do menu OSD (←→ troca, Enter continua). */
  readonly propsGrupo: {
    readonly ref: (el: HTMLElement | null) => void;
    readonly tabIndex: 0 | -1;
    readonly 'data-linha': string;
    readonly onFocus: () => void;
  };
};

/**
 * A escolha de resolução como um aparelho: o número grande acende a cada
 * troca, o quadro mostra o tamanho da imagem contra a de 1080p (a área em
 * pixels é o que a subida paga) e as abas deixam ver todos os degraus de uma
 * vez. Sem lista de janelas: quem escolhe tela, janela ou aba é o seletor do
 * próprio navegador, que abre ao ir ao ar.
 */
export function SeletorDeResolucao({ opcoes, escolhido, sustentavel, ajuda, aoEscolher, propsGrupo }: Props) {
  const atual = opcoes.find((o) => o.id === escolhido) ?? opcoes[0];
  if (atual === undefined) return null;
  const topo = opcoes[0] ?? atual;
  const escalaL = (atual.largura / topo.largura) * 100;
  const escalaA = (atual.altura / topo.altura) * 100;

  return (
    <div className="flex flex-col">
      <div className="flex flex-col items-center gap-4 px-4 pb-2 pt-5 sm:px-6">
        {/* O quadro: 1080p tracejado ao fundo, a imagem escolhida por cima. */}
        <div className="relative aspect-video w-full max-w-[520px] border-2 border-dashed border-line bg-deep">
          <div
            className="absolute bottom-0 left-0 flex items-end justify-start border-2 border-accent bg-[radial-gradient(ellipse_at_30%_30%,rgb(242_169_59_/_0.28),rgb(242_169_59_/_0.06))] p-2 shadow-[0_0_24px_rgb(242_169_59_/_0.25)] transition-[width,height] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none"
            style={{ width: `${escalaL}%`, height: `${escalaA}%` }}
          >
            <span className="rotulo !text-accent-hi">
              {atual.largura}×{atual.altura}
            </span>
          </div>
          <span className="rotulo absolute right-2 top-2">
            {topo.largura}×{topo.altura}
          </span>
        </div>

        <p
          key={atual.id}
          aria-live="polite"
          className="numeral entra m-0 text-[clamp(48px,7vw,80px)] leading-none text-accent-hi [text-shadow:0_0_18px_rgb(242_169_59_/_0.45),3px_3px_0_#000]"
        >
          {atual.rotulo}
        </p>
      </div>

      <div
        {...propsGrupo}
        role="radiogroup"
        aria-label="Resolução"
        aria-describedby="ajuda-resolucao"
        className="mx-3 flex flex-wrap justify-center gap-1.5 p-1 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:mx-4"
      >
        {opcoes.map((o) => {
          const marcado = o.id === atual.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={marcado}
              tabIndex={-1}
              onClick={() => aoEscolher(o.id)}
              className={[
                'relative flex min-h-11 min-w-[88px] flex-col items-center justify-center gap-0.5 border-2 px-3 font-[family-name:var(--font-pixel)] text-[12px] transition-colors duration-150',
                marcado
                  ? 'border-accent bg-accent text-ink shadow-[0_0_16px_rgb(242_169_59_/_0.3)]'
                  : 'border-line bg-surface text-text hover:border-accent-lo hover:text-accent-hi',
              ].join(' ')}
            >
              {o.rotulo}
              {o.id === sustentavel && (
                <span className={`text-[9px] ${marcado ? 'text-ink' : 'text-ok'}`}>✓ JÁ AGUENTOU</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-3 border-t-2 border-line">
        <Medidor
          rotulo="O que esta resolução pede"
          colunas={3}
          tamanho="p"
          medidas={[
            { rotulo: 'IMAGEM', valor: `${atual.largura}×${atual.altura}` },
            { rotulo: 'QUADROS', valor: `${atual.fps} fps` },
            { rotulo: 'SUBIDA POR AMIGO', valor: `~${atual.mbps} Mbps`, tom: 'destaque' },
          ]}
        />
      </div>

      <p
        id="ajuda-resolucao"
        className="m-0 border-t-2 border-line px-4 py-3 text-[12px] leading-relaxed text-muted [text-wrap:pretty] sm:px-5"
      >
        {ajuda}
      </p>
    </div>
  );
}
