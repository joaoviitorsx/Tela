/**
 * O encoder está sem fôlego? É o sinal que faz a escada trocar RESOLUÇÃO por
 * fluidez (R5: perder resolução, nunca framerate).
 *
 * A versão anterior só acusava quando a fila interna do encoder transbordava
 * (`encodeQueueSize > 2`). Medido com a CPU disputada (a bancada
 * `e2e/fluidez.e2e.mjs` com um "jogo" ocupando todos os núcleos): o encoder
 * levava 40 a 165 ms por quadro — o orçamento a 60 fps é 16,7 —, saíam 21 a
 * 41 fps, e o sinal acendia em 3 de 40 amostras. A escada exige 5 seguidas e
 * nunca desceu: o espectador via 27 fps aos trancos em 720p, quando 540p60
 * fluido estava ali.
 *
 * Duas condições JUNTAS, para não confundir com o que não é sobrecarga:
 *  - quadro demorando mais que `FATOR_DE_LATENCIA` × o orçamento — encoder de
 *    hardware saudável fica bem abaixo, mesmo com 1–2 quadros de pipeline;
 *  - FPS de saída abaixo de `FRACAO_DO_ALVO` do alvo — tela parada também
 *    tem FPS baixo, mas com latência baixa (o capturador só não manda).
 */
export const FATOR_DE_LATENCIA = 2;
export const FRACAO_DO_ALVO = 0.85;

export function encoderSobrecarregado(m: {
  /** Quadros recusados na entrada (fila do encoder cheia) desde a última leitura. */
  readonly descartes: number;
  /** Latência média entrada→saída desde a última leitura; `null` sem amostra. */
  readonly msPorQuadro: number | null;
  readonly fps: number;
  readonly fpsAlvo: number;
}): boolean {
  if (m.descartes > 0) return true;
  if (m.msPorQuadro === null || !(m.fpsAlvo > 0)) return false;
  const orcamentoMs = 1000 / m.fpsAlvo;
  return m.msPorQuadro > orcamentoMs * FATOR_DE_LATENCIA && m.fps < m.fpsAlvo * FRACAO_DO_ALVO;
}
