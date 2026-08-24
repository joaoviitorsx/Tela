/**
 * Como o aparelho se apoia na vitrine.
 *
 * Função pura de tempo, ponteiro e impulso — sem three.js, sem DOM, sem
 * relógio. Quem chama decide de onde vem o tempo, e é por isso que "a TV nunca
 * mostra as costas" é um teste e não uma esperança.
 *
 * # Por que pêndulo e não giro completo
 *
 * "Girando sozinha" pede giro; o modelo desaconselha. As costas do gabinete são
 * uma caixa arredondada lisa — sem tela, sem antena, sem painel. Num giro de
 * 360° metade do tempo o produto mostra um bloco cinza sem informação nenhuma,
 * e a peça que dá nome à empresa fica escondida justamente na metade do ciclo.
 *
 * O pêndulo de ±26° resolve os dois: a tela nunca sai de vista, o paralaxe do
 * painel lateral e das antenas prova que é 3D a cada segundo, e a volta tem
 * desaceleração natural nos extremos porque um seno já desacelera ali — sem
 * easing nenhum escrito à mão.
 */

export type Ponteiro = {
  /** -1 (esquerda) a 1 (direita) dentro do canvas. */
  readonly x: number;
  /** -1 (topo) a 1 (base). */
  readonly y: number;
};

export type EntradaPose = {
  /** Segundos desde que a vitrine montou. */
  readonly t: number;
  /** Onde o cursor está, ou `null` quando ele saiu do canvas. */
  readonly ponteiro: Ponteiro | null;
  /** Energia do último clique, de 1 a 0. Quem decai é quem chama. */
  readonly impulso: number;
};

export type Pose = {
  readonly rotY: number;
  readonly rotX: number;
  /** Flutuação vertical, em unidades de cena. */
  readonly alturaY: number;
  readonly escala: number;
  /** Chiado EXTRA do clique. O chiado de estado vem de outro lugar. */
  readonly chiado: number;
};

/** ±26°. Ver a nota sobre o pêndulo acima. */
export const AMPLITUDE_RAD = 0.45;

/** Uma volta inteira do pêndulo. Lento o bastante para não puxar o olho. */
export const PERIODO_S = 13;

/** A flutuação tem período primo em relação ao pêndulo, senão o ciclo fica óbvio. */
const PERIODO_BOIA_S = 7.4;
const BOIA = 0.012;

/** Quanto o aparelho se inclina na direção do cursor. */
const PARALAXE_Y = 0.2;
const PARALAXE_X = 0.13;

/** O empurrão do clique: um giro extra que decai, e um recuo de escala. */
const IMPULSO_GIRO = 0.34;
const IMPULSO_RECUO = 0.055;

/**
 * O limite que o teste guarda: passar disto começa a mostrar a lateral cega e,
 * adiante, as costas. A soma de amplitude, paralaxe e impulso tem de caber aqui
 * com folga — hoje o pior caso dá 0,99 rad contra 1,57 de teto.
 */
export const LIMITE_RAD = Math.PI / 2;

export function poseVitrine({ t, ponteiro, impulso }: EntradaPose): Pose {
  const pendulo = AMPLITUDE_RAD * Math.sin((2 * Math.PI * t) / PERIODO_S);
  const boia = BOIA * Math.sin((2 * Math.PI * t) / PERIODO_BOIA_S);

  return {
    rotY: pendulo + (ponteiro?.x ?? 0) * PARALAXE_Y + impulso * IMPULSO_GIRO,
    // Invertido: cursor em cima faz o aparelho olhar para cima, e é assim que
    // um objeto na mão responde. Sem o sinal, ele foge do cursor.
    rotX: -(ponteiro?.y ?? 0) * PARALAXE_X,
    alturaY: boia,
    escala: 1 - impulso * IMPULSO_RECUO,
    chiado: impulso,
  };
}

/**
 * A pose de quem pediu `prefers-reduced-motion`.
 *
 * Um 3/4 parado, e não a pose frontal: parado E frontal, o modelo vira uma
 * imagem e não há mais motivo para ele ser 3D. A inclinação é o que sobra da
 * profundidade quando o movimento sai.
 */
export function poseParada(): Pose {
  return {
    rotY: 0.3,
    rotX: -0.06,
    alturaY: 0,
    escala: 1,
    chiado: 0,
  };
}
