import type { ReactNode } from 'react';

/** Uma vaga OCUPADA. As livres não viram objeto: são `total − vagas.length`. */
export type Vaga = {
  readonly n: string;
  readonly nome: string;
  readonly estado: string;
  readonly tom: 'ok' | 'alerta';
};

type Props = {
  readonly vagas: readonly Vaga[];
  readonly total: number;
  readonly icone: ReactNode;
};

const COR = { ok: 'text-ok', alerta: 'text-warn' } as const;
const CELULA = {
  ok: 'bg-ok',
  alerta: 'bg-warn',
  vazio: 'border border-line bg-transparent',
} as const;

/**
 * Até aqui, cada vaga livre ganha uma linha própria na lista. Acima, as livres
 * viram uma linha só com a contagem: 45 linhas de "vaga livre" é uma parede
 * que esconde quem está de fato assistindo.
 */
const LISTA_COMPLETA_ATE = 8;

/**
 * As vagas da sala: "12/50" e, aberto, quem ocupa cada uma.
 *
 * O teto varia por transmissor — 5 em quem codifica uma vez por peer, 50 em
 * quem codifica uma vez para todos — e o mesmo componente serve os dois sem
 * virar uma parede de caixas: a tira de células é o mapa da sala (uma célula
 * por vaga, acesa quando ocupada, como um medidor de memória), e a lista só
 * tem quem está dentro, com as livres resumidas numa linha.
 *
 * Disclosure nativo (`<details>`): teclado (`Enter`/`Space`), estado e leitor
 * de tela sem código. No protótipo abria com o mouse por cima; aqui abre com
 * clique/toque/tecla, porque o transmissor está no jogo e um popover que
 * aparece por acaso cobre o que importa.
 *
 * Não há contas: o nome é o apelido que a pessoa deu ao entrar, ou a ordem de
 * chegada, e a linha diz o que se sabe — assistindo, conectando, via TURN.
 */
export function SalaVagas({ vagas, total, icone }: Props) {
  const ocupadas = vagas.length;
  const livres = Math.max(0, total - ocupadas);
  const listaCompleta = total <= LISTA_COMPLETA_ATE;
  const celulas = Array.from({ length: total }, (_, i) => vagas[i]?.tom ?? 'vazio');

  return (
    <details
      className="group relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.currentTarget.removeAttribute('open');
      }}
    >
      <summary
        className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 marker:hidden [&::-webkit-details-marker]:hidden"
        aria-label={`Sala: ${ocupadas} de ${total} vagas ocupadas. Ver quem está assistindo`}
      >
        {icone}
        <span className="numeral text-[26px]">
          {ocupadas}/{total}
        </span>
      </summary>

      <div className="absolute right-0 top-full z-30 flex w-[min(300px,calc(100vw-32px))] flex-col border-2 border-edge bg-surface shadow-[0_0_0_2px_#000,0_18px_40px_rgb(0_0_0_/_0.6)]">
        <div className="titulo-osd">
          <span className="text-[12px]">SALA ▸ VAGAS</span>
          <div className="flex-1" />
          <span className="text-[11px] font-normal">
            {ocupadas}/{total}
          </span>
        </div>

        {/* O mapa da sala: uma célula por vaga. Dez por linha — 50 vagas são cinco linhas. */}
        <div
          role="img"
          aria-label={`${ocupadas} de ${total} vagas ocupadas`}
          data-testid="mapa-da-sala"
          className="grid grid-cols-10 gap-1 border-b-2 border-line px-2.5 py-2"
        >
          {celulas.map((tom, i) => (
            <span key={i} data-tom={tom} className={`h-2.5 w-full ${CELULA[tom]}`} />
          ))}
        </div>

        <ul className="m-0 flex max-h-[min(50vh,420px)] list-none flex-col gap-0.5 overflow-y-auto p-1.5">
          {vagas.map((v) => (
            <li
              key={v.n}
              className="grid min-h-10 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 bg-key px-2.5"
            >
              <span className="numeral text-[20px] text-dim">{v.n}</span>
              <span className="truncate font-[family-name:var(--font-pixel)] text-[11px] text-text">
                {v.nome}
              </span>
              <span className={`font-[family-name:var(--font-pixel)] text-[11px] ${COR[v.tom]}`}>
                {v.tom === 'alerta' ? '! ' : ''}
                {v.estado}
              </span>
            </li>
          ))}
          {listaCompleta ? (
            Array.from({ length: livres }, (_, i) => {
              const n = String(ocupadas + i + 1).padStart(2, '0');
              return (
                <li
                  key={n}
                  className="grid min-h-10 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5"
                >
                  <span className="numeral text-[20px] text-dim">{n}</span>
                  <span className="truncate font-[family-name:var(--font-pixel)] text-[11px] text-faint">
                    vaga livre
                  </span>
                  <span className="font-[family-name:var(--font-pixel)] text-[11px] text-faint">—</span>
                </li>
              );
            })
          ) : livres > 0 ? (
            <li className="flex min-h-10 items-center px-2.5 font-[family-name:var(--font-pixel)] text-[11px] text-faint">
              {livres === 1 ? '1 VAGA LIVRE' : `${livres} VAGAS LIVRES`}
            </li>
          ) : null}
        </ul>
        <p className="m-0 border-t-2 border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">
          Cada vaga é uma cópia inteira do vídeo saindo da sua máquina. O que limita é a sua subida.
        </p>
      </div>
    </details>
  );
}
