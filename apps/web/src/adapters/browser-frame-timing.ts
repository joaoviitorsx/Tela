import type {
  AmostraLatencia,
  FrameTiming,
  OrigemLatencia,
} from '../core/ports/frame-timing.js';

/**
 * `requestVideoFrameCallback` — a única API do navegador que fecha a conta de
 * latência.
 *
 * `getStats()` mede pedaços: RTT é a rede, `totalProcessingDelay` vai do
 * primeiro pacote até o decode. Faltam captura, encode, o pacer e o render — e
 * um relato de "cerca de um segundo" num caminho de 58ms significa exatamente
 * que a resposta está nas fatias que não medimos.
 *
 * Isto entrega, por quadro apresentado, quando ele foi capturado do outro lado
 * e quando vai ser exibido deste. A diferença é a latência inteira.
 *
 * `contentHint`, `setParameters` e companhia são gratuitos onde não existem;
 * este não é. Sem `requestVideoFrameCallback` o `observe` devolve um
 * cancelamento vazio e ninguém recebe amostra — o consumidor tem que aguentar
 * `null` para sempre, e aguenta.
 */
type MetadadosDeQuadro = {
  readonly expectedDisplayTime: number;
  /**
   * Quando o quadro foi capturado na outra ponta, no mesmo relógio do
   * `performance.now()` daqui.
   *
   * Só existe com a extensão RTP `abs-capture-time` negociada, e o Chromium só
   * a oferece em algumas configurações. Quando falta, `receiveTime` dá a parte
   * de cá — que subestima, e por isso a origem viaja junto com o número.
   */
  readonly captureTime?: number;
  readonly receiveTime?: number;
};

type VideoComCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, metadata: MetadadosDeQuadro) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function makeBrowserFrameTiming(video: HTMLVideoElement): FrameTiming {
  return {
    observe(onAmostra: (amostra: AmostraLatencia) => void): () => void {
      const el = video as VideoComCallback;
      if (typeof el.requestVideoFrameCallback !== 'function') return () => undefined;

      let vivo = true;
      let handle = 0;

      const passo = (_now: number, meta: MetadadosDeQuadro): void => {
        if (!vivo) return;

        const medida = medir(meta);
        if (medida !== null) onAmostra(medida);

        // Reagenda SEMPRE, inclusive quando a medida saiu vazia: um quadro sem
        // metadado não é motivo para parar de observar os próximos.
        handle = el.requestVideoFrameCallback!(passo);
      };

      handle = el.requestVideoFrameCallback(passo);

      return () => {
        vivo = false;
        el.cancelVideoFrameCallback?.(handle);
      };
    },
  };
}

/**
 * Prefere a medida COMPLETA e cai para a parcial, sempre dizendo qual é.
 *
 * Anunciar `recepcao` como se fosse ponta a ponta seria repetir o erro que o
 * HUD cometia ao chamar RTT de latência: um número menor que a verdade, com
 * ar de precisão.
 */
function medir(meta: MetadadosDeQuadro): AmostraLatencia | null {
  const exibicao = meta.expectedDisplayTime;
  if (!Number.isFinite(exibicao)) return null;

  const candidatos: ReadonlyArray<readonly [number | undefined, OrigemLatencia]> = [
    [meta.captureTime, 'captura'],
    [meta.receiveTime, 'recepcao'],
  ];

  for (const [instante, origem] of candidatos) {
    if (instante === undefined || !Number.isFinite(instante)) continue;
    const ms = exibicao - instante;
    // Negativo é relógio fora de sincronia entre as pontas, não adiantamento.
    if (ms < 0) continue;
    return { ms, origem };
  }
  return null;
}
