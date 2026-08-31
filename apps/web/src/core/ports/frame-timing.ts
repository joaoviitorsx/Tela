/**
 * A latência que o espectador de fato SENTE, medida no quadro.
 *
 * # Por que uma porta só para isto
 *
 * `getStats()` mede pedaços: RTT é a rede, `totalProcessingDelay` é do primeiro
 * pacote até o decode. Nenhum dos dois inclui captura, encode, o pacer nem o
 * render — e um relato de "cerca de um segundo de atraso" num caminho de 58ms
 * significa exatamente que a resposta está nas fatias que não medimos.
 *
 * `requestVideoFrameCallback` é a única API do navegador que fecha a conta:
 * ela entrega, por quadro apresentado, o instante em que ele foi CAPTURADO na
 * outra ponta e o instante em que vai ser EXIBIDO nesta. A diferença é a
 * latência ponta a ponta, sem estimativa.
 *
 * Fica atrás de uma porta porque depende de `HTMLVideoElement`, e
 * `core/` não conhece DOM (R1/R3) — a medição vale igual na Fase 3, onde o
 * elemento não existe.
 */

/** De onde veio o número, porque a precisão depende disso. */
export type OrigemLatencia =
  /**
   * `expectedDisplayTime − captureTime`: ponta a ponta de verdade, incluindo
   * captura e encode. Exige a extensão RTP `abs-capture-time` negociada, e o
   * navegador só a oferece em algumas configurações.
   */
  | 'captura'
  /**
   * `expectedDisplayTime − receiveTime`: só o que acontece DEPOIS da rede.
   * Perde captura, encode e trânsito — subestima, e o consumidor precisa saber
   * disso para não anunciar um número menor do que a verdade.
   */
  | 'recepcao';

export type AmostraLatencia = {
  readonly ms: number;
  readonly origem: OrigemLatencia;
};

export type FrameTiming = {
  /**
   * Começa a observar. Devolve o cancelamento.
   *
   * O callback é chamado no máximo uma vez por quadro apresentado, então numa
   * transmissão a 60fps ele roda 60 vezes por segundo — quem consome precisa
   * ser barato ou amostrar.
   */
  observe(onAmostra: (amostra: AmostraLatencia) => void): () => void;
};
