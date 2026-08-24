import type { QuadroAbertura } from '../intro/timeline.js';

/**
 * O palco 3D da abertura, atrás de uma porta.
 *
 * O three.js é a primeira biblioteca de renderização que entra no projeto, e o
 * AGENTS.md pede que toda lib externa entre atrás de uma port. O motivo aqui
 * não é cerimônia: a §9 da coreografia já descreve uma variante sem câmera e
 * sem barril, e a §11 pede a mesma pilha de camadas rodando a 12 fps no estado
 * offline. Nenhuma das duas precisa de um motor 3D — as duas precisam desta
 * interface.
 *
 * Quem implementa recebe QUADROS, nunca tempo. A linha do tempo é de
 * `core/intro/timeline.ts` e o relógio é de quem chama.
 */

/**
 * Uma caixa da interface real, medida no DOM, em pixels CSS a partir do canto
 * superior esquerdo da janela.
 *
 * É o que a L3 desenha dentro do tubo (§4). A especificação pede um instantâneo
 * da home; isto é um desvio consciente, e o motivo está em
 * `adapters/three-crt-stage.ts`.
 */
export type PlacaDaTela = {
  readonly x: number;
  readonly y: number;
  readonly largura: number;
  readonly altura: number;
  readonly tipo: 'contorno' | 'preenchido' | 'acento' | 'texto';
};

export type PalcoAbertura = {
  /** Pinta um quadro. Idempotente: o mesmo quadro dá o mesmo pixel. */
  readonly render: (quadro: QuadroAbertura) => void;
  /**
   * Pinta um quadro e ESPERA a GPU terminar. Devolve o custo, em ms.
   *
   * É o passo 4 da §2: o quadro de aquecimento. Sem esperar a GPU a medição
   * volta antes de o trabalho acontecer, e uma máquina fraca passaria no teste
   * com folga. Vale uma chamada só, no quadro zero — `finish()` a cada quadro
   * serializa CPU e GPU e destrói o desempenho que se quer medir.
   */
  readonly aquece: (quadro: QuadroAbertura) => number;
  /**
   * Onde o dolly precisa parar para o vidro cobrir a janela inteira, nesta
   * proporção de tela. Vai direto para `sampleIntro(t, zFinal)`.
   *
   * É função e não valor porque muda quando a janela muda: girar o celular no
   * meio da abertura não pode fazer a moldura aparecer no handoff.
   */
  readonly zFinal: () => number;
  readonly redimensiona: (larguraCss: number, alturaCss: number, dpr: number) => void;
  /**
   * Devolve TODA a memória de GPU e encerra o contexto.
   *
   * O three.js não libera nada sozinho: geometria, material e textura ficam na
   * VRAM até alguém chamar `dispose()`. E esconder o canvas com `display:none`
   * mantém o contexto vivo — o aparelho segue esquentando (§7).
   */
  readonly dispose: () => void;
};

export type AberturaPalcoOpcoes = {
  readonly canvas: HTMLCanvasElement;
  readonly modeloUrl: string;
  readonly placas: readonly PlacaDaTela[];
  readonly larguraCss: number;
  readonly alturaCss: number;
  readonly dpr: number;
  /** Cancela o carregamento se a abertura for pulada antes de o modelo chegar. */
  readonly sinal: AbortSignal;
};

export type AbrePalco = (opcoes: AberturaPalcoOpcoes) => Promise<PalcoAbertura>;
