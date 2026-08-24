export type SignalNode = {
  /** O que é este ponto do caminho. Serigrafia. */
  readonly rotulo: string;
  /** O número ou fato daquele ponto. Tabular, porque quase sempre é número. */
  readonly valor: string;
  /** Uma frase curta, só onde o valor sozinho não se explica. */
  readonly nota?: string;
  /** Este ponto está degradado — ver `tom` na chamada. */
  readonly alerta?: boolean;
};

type Props = {
  readonly nodes: readonly SignalNode[];
  readonly rotulo: string;
};

/**
 * O caminho do vídeo, desenhado.
 *
 * Este é o elemento-assinatura do produto e existe pelo motivo mais simples
 * possível: **o produto inteiro é um caminho**. Da tela da pessoa até a tela
 * do amigo, sem servidor no meio. Nenhuma outra coisa que essa interface
 * poderia mostrar é tão específica deste produto quanto essa reta.
 *
 * Ele aparece duas vezes, com o mesmo desenho e conteúdos diferentes:
 *
 * - Na tela inicial, os números são os do preset ESCOLHIDO — trocar de
 *   1080p60 para 720p60 muda o nó do meio na hora. É a única forma honesta de
 *   responder "o que muda se eu mexer aqui" antes de transmitir.
 * - Ao vivo, os mesmos nós carregam os números MEDIDOS. O desenho não muda;
 *   só o que ele diz. Quem já viu a reta na home reconhece a reta no ar.
 *
 * A ordem aqui é informação, não decoração: é a ordem física por onde o pixel
 * passa. Por isso é uma `<ol>`, e por isso não há numeração 01/02/03 — o
 * traço já diz que existe sequência, e o número seria o mesmo dado escrito
 * duas vezes.
 *
 * No celular a reta vira vertical. Quatro colunas de 80px não cabem sem
 * quebrar rótulo no meio da palavra, e uma reta quebrada não se lê como
 * caminho. Vertical é o mesmo desenho girado, não um segundo desenho.
 */
export function SignalChain({ nodes, rotulo }: Props) {
  return (
    <section aria-label={rotulo}>
      <p className="serigrafia mb-3">{rotulo}</p>

      <ol className="flex flex-col sm:grid sm:grid-flow-col sm:auto-cols-fr">
        {nodes.map((node, i) => {
          const ultimo = i === nodes.length - 1;
          return (
            <li key={node.rotulo} className="flex gap-3 sm:flex-col sm:gap-3">
              {/*
                O trilho. Em coluna ele desce ao lado do texto; em linha ele
                atravessa por cima. Mesmo elemento, mesma cor, eixo trocado —
                por isso as utilidades vêm em pares e não em dois blocos.

                `edge` e não `line`: aqui a linha não é um divisor decorativo,
                é o desenho. Em `line` (1,14:1 sobre `surface`) ela some e
                sobram quatro colunas de texto soltas — foi o que aconteceu na
                primeira versão desta tela.
              */}
              <span
                aria-hidden="true"
                className="flex shrink-0 flex-col items-center sm:w-full sm:flex-row"
              >
                <span
                  className={[
                    'h-2 w-2 shrink-0 rounded-full',
                    node.alerta ? 'bg-warn' : 'bg-muted',
                  ].join(' ')}
                />
                {!ultimo && (
                  <span className="my-1 w-px flex-1 bg-edge sm:my-0 sm:ml-2 sm:h-px sm:w-auto" />
                )}
              </span>

              <div className="flex min-w-0 flex-col gap-1 pb-5 pr-5 last:pb-0 sm:pb-0">
                <span className="serigrafia">{node.rotulo}</span>
                <span
                  className={`tabular text-[15px] leading-tight ${
                    node.alerta ? 'text-warn' : 'text-text'
                  }`}
                >
                  {node.valor}
                </span>
                {node.nota !== undefined && (
                  <span className="text-[12px] leading-snug text-muted">{node.nota}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
