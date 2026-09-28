import type { ReactNode } from 'react';

export type Vaga = {
  readonly n: string;
  /** `null` = vaga livre. */
  readonly nome: string | null;
  readonly estado: string;
  readonly tom: 'ok' | 'alerta' | 'vazio';
};

type Props = {
  readonly vagas: readonly Vaga[];
  readonly total: number;
  readonly ocupadas: number;
  readonly icone: ReactNode;
};

const COR = { ok: 'text-ok', alerta: 'text-warn', vazio: 'text-faint' } as const;

/**
 * As vagas da sala: "3/5" e, aberto, quem ocupa cada uma.
 *
 * Disclosure nativo (`<details>`): teclado (`Enter`/`Space`), estado e leitor
 * de tela sem código. No protótipo abria com o mouse por cima; aqui abre com
 * clique/toque/tecla, porque o transmissor está no jogo e um popover que
 * aparece por acaso cobre o que importa.
 *
 * Não há nomes: o produto não tem contas. "ESPECTADOR 2" é só a ordem de
 * chegada, e a linha diz o que se sabe — assistindo, conectando, via TURN.
 */
export function SalaVagas({ vagas, total, ocupadas, icone }: Props) {
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
        <ul className="m-0 flex list-none flex-col gap-0.5 p-1.5">
          {vagas.map((v) => (
            <li
              key={v.n}
              className={[
                'grid min-h-10 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5',
                v.nome === null ? '' : 'bg-key',
              ].join(' ')}
            >
              <span className="numeral text-[20px] text-dim">{v.n}</span>
              <span
                className={`truncate font-[family-name:var(--font-pixel)] text-[11px] ${v.nome === null ? 'text-faint' : 'text-text'}`}
              >
                {v.nome ?? 'vaga livre'}
              </span>
              <span className={`font-[family-name:var(--font-pixel)] text-[11px] ${COR[v.tom]}`}>
                {v.tom === 'alerta' ? '! ' : ''}
                {v.estado}
              </span>
            </li>
          ))}
        </ul>
        <p className="m-0 border-t-2 border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">
          Cada vaga é uma cópia inteira do vídeo saindo da sua máquina. O que limita é a sua subida.
        </p>
      </div>
    </details>
  );
}
