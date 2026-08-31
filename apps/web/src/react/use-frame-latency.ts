import { useEffect } from 'react';
import { frameTimingDe } from '../container.js';
import type { AmostraLatencia } from '../core/ports/frame-timing.js';

/**
 * Liga `requestVideoFrameCallback` ao elemento e entrega cada medida.
 *
 * Fica em `react/` e não em `core/` porque depende de `HTMLVideoElement`, e
 * `core/` não conhece DOM (R1/R3). O hook é fino de propósito: quem decide o
 * que fazer com o número é a sessão, que é pura e testável.
 *
 * O callback roda uma vez por quadro apresentado — 60 vezes por segundo numa
 * transmissão saudável. `onAmostra` precisa ser barato, e a `LatencyWatch` do
 * outro lado só alimenta uma média móvel.
 */
export function useFrameLatency(
  video: HTMLVideoElement | null,
  ativo: boolean,
  onAmostra: (amostra: AmostraLatencia) => void,
): void {
  useEffect(() => {
    if (video === null || !ativo) return;
    return frameTimingDe(video).observe(onAmostra);
  }, [video, ativo, onAmostra]);
}
