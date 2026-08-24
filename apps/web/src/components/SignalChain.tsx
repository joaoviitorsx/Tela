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

export type Saidas = {
  /** Quantas cópias saem da máquina. É o teto do canal, não uma estimativa. */
  readonly total: number;
  /** Quantas estão ocupadas agora. Zero na tela inicial: ninguém entrou ainda. */
  readonly ocupadas?: number;
};

type Props = {
  readonly nodes: readonly SignalNode[];
  readonly rotulo: string;
  /**
   * O leque do fim do caminho. Quando presente, o último nó deixa de ter valor
   * escrito e passa a ter DESENHO: uma saída por espectador.
   */
  readonly saidas?: Saidas;
};

/**
 * O caminho do vídeo, andando.
 *
 * Este é o elemento-assinatura do produto e existe pelo motivo mais simples
 * possível: **o produto inteiro é um caminho**. Da tela da pessoa até a tela do
 * amigo, sem servidor no meio. Nenhuma outra coisa que esta interface poderia
 * mostrar é tão específica deste produto quanto essa reta.
 *
 * Ele aparece duas vezes, com o mesmo desenho e conteúdos diferentes:
 *
 * - Na tela inicial, os números são os do preset ESCOLHIDO — trocar de 1080p60
 *   para 720p60 muda o nó do meio na hora. É a única forma honesta de responder
 *   "o que muda se eu mexer aqui" antes de transmitir.
 * - Ao vivo, os mesmos nós carregam os números MEDIDOS. O desenho não muda; só
 *   o que ele diz. Quem já viu a reta na home reconhece a reta no ar.
 *
 * A ordem aqui é informação, não decoração: é a ordem física por onde o pixel
 * passa. Por isso é uma `<ol>`, e por isso não há numeração 01/02/03 — o traço
 * já diz que existe sequência, e o número seria o mesmo dado escrito duas
 * vezes.
 *
 * # Por que o traço se mexe
 *
 * Porque parado ele é um diagrama e andando ele é uma explicação. Um pulso
 * atravessa a reta em 2,2 s, cada nó acende quando o pulso passa por ele, e no
 * fim ele acende as CINCO saídas. Quem olha vê a direção do vídeo e vê que a
 * mesma imagem sai cinco vezes da própria máquina — que é a resposta para "por
 * que o teto é cinco", e era um parágrafo numa coluna de texto que foi embora.
 *
 * O ciclo tem 1,0 s de descanso depois dos 2,2 s de viagem. Sem o descanso vira
 * marquee, e marquee no rodapé de uma tela onde a pessoa está digitando é
 * exatamente o tipo de animação infinita que atrapalha. Cinza, nunca verde: o
 * acento é do AO VIVO, e aqui nada está no ar ainda.
 *
 * Quem pediu `prefers-reduced-motion` recebe o mesmo desenho parado — a
 * informação está na FORMA (a reta, o leque), não no movimento. O movimento só
 * a apressa.
 *
 * No celular a reta vira vertical. Quatro colunas de 80px não cabem sem quebrar
 * rótulo no meio da palavra, e uma reta quebrada não se lê como caminho.
 */
export function SignalChain({ nodes, rotulo, saidas }: Props) {
  return (
    <section aria-label={rotulo}>
      <p data-vidro="texto" className="serigrafia mb-3">
        {rotulo}
      </p>

      {/*
        O trilho horizontal e o pulso moram FORA da lista, atravessando-a por
        cima. Segmentar o trilho por coluna faria o pulso reiniciar em cada nó,
        e o que se lê é o contrário: um pixel só, atravessando o caminho todo.
      */}
      <div className="relative">
        {/*
          O trilho termina no ÚLTIMO nó, não na borda da caixa. Com
          `auto-cols-fr` cada nó senta no começo da sua coluna, então a última
          coluna inteira sobra à direita — e um trilho que passasse do último nó
          faria o pulso andar por um trecho de caminho que não existe.
        */}
        <span
          aria-hidden="true"
          className="absolute left-1 top-1 hidden h-px overflow-hidden bg-edge sm:block"
          style={{ right: `calc(${100 / Math.max(nodes.length, 1)}% - 0.25rem)` }}
        >
          {/*
            O pulso ocupa a largura inteira do trilho e leva o brilho numa fatia
            do gradiente. Assim o `translateX` é percentual da PRÓPRIA largura e
            a animação continua em transform puro, sem tocar em layout — a mesma
            razão de não animar `left`.
          */}
          <span className="caminho-pulso absolute inset-0 block bg-[linear-gradient(90deg,transparent_44%,var(--color-text)_50%,transparent_56%)]" />
        </span>

        <ol className="flex flex-col sm:grid sm:grid-flow-col sm:auto-cols-fr">
          {nodes.map((node, i) => {
            const ultimo = i === nodes.length - 1;
            const fracao = nodes.length > 1 ? i / (nodes.length - 1) : 0;

            return (
              <li key={node.rotulo} className="flex gap-3 sm:flex-col sm:gap-3">
                {/*
                  Em coluna o trilho desce ao lado do texto; em linha quem
                  atravessa é o trilho de cima e aqui fica só o nó. Mesmo
                  elemento, eixo trocado — por isso as utilidades vêm em pares.
                */}
                <span
                  aria-hidden="true"
                  className="flex shrink-0 flex-col items-center sm:w-full sm:flex-row"
                >
                  {/*
                    Nó em alerta não pisca junto com o pulso: a cor âmbar é
                    estado, e um estado que acende e apaga a cada 3,2 s lê como
                    parte da animação em vez de como aviso.
                  */}
                  <span
                    className={[
                      'h-2 w-2 shrink-0 rounded-full',
                      node.alerta === true ? 'bg-warn' : 'caminho-no bg-muted',
                    ].join(' ')}
                    style={
                      node.alerta === true ? undefined : { animationDelay: `${atrasoDoNo(fracao)}s` }
                    }
                  />
                  {!ultimo && <span className="my-1 w-px flex-1 bg-edge sm:hidden" />}
                </span>

                <div className="flex min-w-0 flex-col gap-1 pb-5 pr-5 last:pb-0 sm:pb-0">
                  {/* `data-vidro`: ver a nota em `react/use-abertura.ts`. */}
                  <span data-vidro="texto" className="serigrafia">
                    {node.rotulo}
                  </span>

                  {ultimo && saidas !== undefined ? (
                    <Leque {...saidas} />
                  ) : (
                    <span
                      data-vidro="texto"
                      className={`tabular text-[15px] leading-tight ${
                        node.alerta === true ? 'text-warn' : 'text-text'
                      }`}
                    >
                      {node.valor}
                    </span>
                  )}

                  {node.nota !== undefined && (
                    <span className="text-[12px] leading-snug text-muted">{node.nota}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/**
 * O leque: uma saída por espectador.
 *
 * É o que transforma "até 5" de frase em desenho. O pulso atravessa a reta e,
 * ao chegar, acende as cinco marcas em sequência: a mesma imagem sai cinco
 * vezes da mesma máquina. Isso também é a explicação do teto — são cinco
 * saídas no PC que está rodando o jogo, não cinco assentos numa sala de
 * servidor —, e era um parágrafo numa coluna de texto que foi embora.
 *
 * Teve tiques verticais ligando cada marca ao trilho, e eles saíram: entre o
 * trilho e a linha do valor mora a serigrafia, então os tiques não encostavam
 * em nada e liam como sujeira. A coluna já diz a que nó as marcas pertencem, e
 * a sequência do clarão já diz que elas vêm de lá.
 *
 * Quadrado, não bolinha: a bolinha deste produto é o LED do AO VIVO, e ela
 * pulsa. Duas famílias de forma para dois significados — a mesma regra do
 * `ViewerSlots`, e de propósito, porque é o mesmo dado no outro lado do fluxo.
 */
function Leque({ total, ocupadas = 0 }: Saidas) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex items-center gap-1.5" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={[
              'h-2.5 w-2.5 rounded-[2px] border',
              i < ocupadas ? 'border-text bg-text' : 'caminho-saida border-edge',
            ].join(' ')}
            style={i < ocupadas ? undefined : { animationDelay: `${SAIDA_ATRASO_S + i * 0.06}s` }}
          />
        ))}
      </span>
      <span className="tabular ml-1 text-[15px] leading-none text-text">até {total}</span>
    </span>
  );
}

/**
 * Quando o pulso passa por cada ponto do trilho.
 *
 * As três constantes são as MESMAS de `@keyframes tela-caminho-pulso` em
 * `globals.css`. Mexer numa sem mexer na outra dessincroniza o clarão do nó da
 * passagem do pulso — que é justamente a coisa que faz o desenho explicar algo.
 */
const CICLO_S = 3.2;
/** Fração do ciclo gasta atravessando; o resto é descanso. */
const VIAGEM = 0.69;
/** `translateX` inicial e final do pulso, em frações da largura do trilho. */
const PARTIDA = -0.6;
const CHEGADA = 0.6;

/** O brilho mora no meio do gradiente, daí o 0,5. */
function atrasoDoNo(fracao: number): number {
  const progresso = (fracao - 0.5 - PARTIDA) / (CHEGADA - PARTIDA);
  return Number((CICLO_S * VIAGEM * progresso).toFixed(3));
}

const SAIDA_ATRASO_S = atrasoDoNo(1);
