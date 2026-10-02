import { DICA_DO_MENU_OSD } from './dica-do-menu-osd.js';

export type OpcaoDeResolucao = {
  readonly id: string;
  readonly rotulo: string;
  readonly largura: number;
  readonly altura: number;
  readonly fps: number;
  /** Subida nominal por espectador, em Mbps, já formatada. */
  readonly mbps: string;
};

type PropsDeLinha = {
  readonly ref: (el: HTMLElement | null) => void;
  readonly tabIndex: 0 | -1;
  readonly 'data-linha': string;
  readonly onFocus: () => void;
};

export type OpcaoDeQuadros = {
  readonly id: string;
  readonly fps: number;
  /** "FLUIDEZ" / "NITIDEZ": o que se ganha, não só o número. */
  readonly nome: string;
};

type Props = {
  readonly opcoes: readonly OpcaoDeResolucao[];
  readonly escolhido: string;
  /** O degrau que a última transmissão sustentou, se houver. */
  readonly sustentavel: string | null;
  readonly ajuda: string;
  readonly aoEscolher: (id: string) => void;
  /** Foco e teclas vêm do menu OSD (←→ troca, Enter continua). */
  readonly propsGrupo: PropsDeLinha;
  readonly quadros: readonly OpcaoDeQuadros[];
  readonly quadrosEscolhido: string;
  readonly aoEscolherQuadros: (id: string) => void;
  readonly propsQuadros: PropsDeLinha;
};

/**
 * A escolha de resolução como um aparelho: o número grande acende a cada
 * troca, o quadro mostra o tamanho da imagem contra a de 1080p (a área em
 * pixels é o que a subida paga) e as abas deixam ver todos os degraus de uma
 * vez. Sem lista de janelas: quem escolhe tela, janela ou aba é o seletor do
 * próprio navegador, que abre ao ir ao ar.
 */
export function SeletorDeResolucao({
  opcoes,
  escolhido,
  sustentavel,
  ajuda,
  aoEscolher,
  propsGrupo,
  quadros,
  quadrosEscolhido,
  aoEscolherQuadros,
  propsQuadros,
}: Props) {
  const atual = opcoes.find((o) => o.id === escolhido) ?? opcoes[0];
  if (atual === undefined) return null;
  const quadroAtual = quadros.find((q) => q.id === quadrosEscolhido) ?? quadros[0];
  const topo = opcoes[0] ?? atual;
  const escalaL = (atual.largura / topo.largura) * 100;
  const escalaA = (atual.altura / topo.altura) * 100;

  return (
    <div className="flex flex-col">
      <span id="dica-menu-osd" className="sr-only">
        {DICA_DO_MENU_OSD}
      </span>
      {/*
        Deitado, e não em pé: o monitor à esquerda, os controles à direita. Em
        pé o card passava de 768 px e escondia a ajuda e o CONTINUAR atrás de
        rolagem. Em tela estreita volta a empilhar.
      */}
      <div className="grid gap-4 px-4 pb-4 pt-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:items-center md:gap-6">
        {/*
          O monitor: 1080p tracejado ao fundo, a imagem escolhida por cima e o
          nome do modo aceso no meio — a prévia e o número viraram uma peça só.
        */}
        <div className="relative mx-auto aspect-video w-full max-w-[440px] border-2 border-dashed border-line bg-deep">
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
          <p
            key={`${atual.id}-${atual.fps}`}
            aria-live="polite"
            className="numeral entra pointer-events-none absolute inset-0 m-0 flex items-center justify-center text-[clamp(40px,5vw,64px)] leading-none text-accent-hi [text-shadow:0_0_18px_rgb(242_169_59_/_0.45),3px_3px_0_#000]"
          >
            {atual.rotulo}
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <span className="rotulo">RESOLUÇÃO</span>
          <div
            {...propsGrupo}
            role="radiogroup"
            aria-label="Resolução"
            aria-describedby={ajuda !== '' ? 'ajuda-resolucao dica-menu-osd' : 'dica-menu-osd'}
            className="-m-1 grid grid-cols-3 gap-1.5 p-1 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
                    'relative flex min-h-11 flex-col items-center justify-center gap-0.5 border-2 px-2 font-[family-name:var(--font-pixel)] text-[12px] transition-colors duration-150',
                    marcado
                      ? 'border-accent bg-accent text-ink shadow-[0_0_16px_rgb(242_169_59_/_0.3)]'
                      : 'border-edge-key bg-surface text-text hover:border-accent-lo hover:text-accent-hi',
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

          {/*
            Quadros por segundo, logo abaixo das resoluções: 60 segura movimento,
            30 dá o dobro de bits a cada quadro. Chave de duas posições, porque é
            um pacote (ADR 0015) e não um número solto.
          */}
          <span className="rotulo mt-1">QUADROS POR SEGUNDO</span>
          <div
            {...propsQuadros}
            role="radiogroup"
            aria-label="Quadros por segundo"
            aria-describedby="dica-menu-osd"
            className="grid grid-cols-2 border-2 border-edge-key bg-deep p-1 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {quadros.map((q) => {
              const marcado = q.id === quadroAtual?.id;
              return (
                <button
                  key={q.id}
                  type="button"
                  role="radio"
                  aria-checked={marcado}
                  tabIndex={-1}
                  onClick={() => aoEscolherQuadros(q.id)}
                  className={[
                    'flex min-h-11 items-center justify-center gap-2 px-3 font-[family-name:var(--font-pixel)] text-[12px] transition-colors duration-150',
                    marcado
                      ? 'bg-accent text-ink shadow-[0_0_16px_rgb(242_169_59_/_0.3)]'
                      : 'text-text hover:text-accent-hi',
                  ].join(' ')}
                >
                  <span className="numeral text-[20px] leading-none">{q.fps}</span>
                  <span>FPS · {q.nome}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/*
        Resolução e quadros já estão escritos no monitor; da medição sobra o que
        só aqui se lê — quanto cada amigo custa de subida — ao lado da ajuda.
      */}
      <div className="flex flex-col gap-2 border-t-2 border-line px-4 py-3 sm:flex-row sm:items-center sm:gap-5 sm:px-5">
        <dl aria-label="O que esta resolução pede" className="m-0 flex shrink-0 items-baseline gap-2">
          <dt className="rotulo">SUBIDA POR AMIGO</dt>
          <dd className="numeral m-0 text-[18px] leading-none text-accent-hi">~{atual.mbps} Mbps</dd>
        </dl>
        {ajuda !== '' && (
          <p id="ajuda-resolucao" className="m-0 text-[12px] leading-relaxed text-muted [text-wrap:pretty]">
            {ajuda}
          </p>
        )}
      </div>
    </div>
  );
}
