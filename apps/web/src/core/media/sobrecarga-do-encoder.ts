/**
 * O encoder está sem fôlego? É o sinal que faz a escada trocar RESOLUÇÃO por
 * fluidez (R5: perder resolução, nunca framerate).
 *
 * A versão anterior só acusava quando a fila interna do encoder transbordava
 * (`encodeQueueSize > 2`). Medido com a CPU disputada (bancada
 * `e2e/fluidez.e2e.mjs`, um "jogo" ocupando todos os núcleos): 40 a 165 ms
 * por quadro, e o sinal acendia em 3 de 40 amostras — a escada pede 5
 * seguidas e nunca descia.
 *
 * A primeira correção comparava a latência com o orçamento do ALVO (60 fps)
 * e exigia FPS de saída abaixo do alvo. A revisão independente mediu o falso
 * positivo: com a fonte a 30 fps (jogo travado em 30, captura 0 Hz) a
 * condição de FPS fica sempre verdadeira, 34–58 ms bastavam, e a escada
 * descia sem ganhar um quadro — e, pela calmaria, não voltava.
 *
 * Agora a latência é comparada com o intervalo REAL da CAPTURA — não com o
 * dos quadros entregues ao encoder, que caem quando ele engasga e subiam o
 * limiar junto com a sobrecarga (segunda revisão). O fator depende de quem
 * codifica: software (OpenH264) não tem pipeline, saudável é menos de um
 * intervalo, e 2,5 deixava a média de ~65 ms oscilando em volta do limiar
 * (35% das leituras acesas, nunca 5 seguidas: a escada não descia nem
 * subia). Hardware segura 1–2 quadros de pipeline: 2,5. Sem saber, 2,5.
 * Média de poucas amostras (tela parada, 2 por segundo) não decide nada.
 */
export const FATOR_DE_LATENCIA = { software: 1.5, hardware: 2.5, desconhecido: 2.5 } as const;
export const AMOSTRAS_MINIMAS = 10;

export function encoderSobrecarregado(m: {
  /** Quadros recusados na entrada (fila do encoder cheia) desde a última leitura. */
  readonly descartes: number;
  /** Latência média entrada→saída desde a última leitura; `null` sem amostra. */
  readonly msPorQuadro: number | null;
  /** Quantas saídas compõem a média. */
  readonly amostras: number;
  /** Intervalo médio entre quadros CAPTURADOS; `null` se nenhum. */
  readonly intervaloDeEntradaMs: number | null;
  readonly fpsAlvo: number;
  readonly classe: keyof typeof FATOR_DE_LATENCIA;
}): boolean {
  if (m.descartes > 0) return true;
  if (m.msPorQuadro === null || m.amostras < AMOSTRAS_MINIMAS || !(m.fpsAlvo > 0)) return false;
  const intervalo = Math.max(1000 / m.fpsAlvo, m.intervaloDeEntradaMs ?? 0);
  return m.msPorQuadro > intervalo * FATOR_DE_LATENCIA[m.classe];
}
