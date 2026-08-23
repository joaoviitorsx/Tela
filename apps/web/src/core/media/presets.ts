import {
  CONTENT_HINT,
  DEGRADATION_PREFERENCE,
  type EncodingPreset,
  PRESET_ORDER,
  PRESETS as SHARED_PRESETS,
  type PresetId,
  SIXTY_FPS_PRESETS,
  VIDEO_CODEC,
  p2pViewerBudget,
  suggestPreset,
} from '@tela/shared';
import type { PublishRequest } from '../ports/media-transport.js';

export { CONTENT_HINT, DEGRADATION_PREFERENCE, VIDEO_CODEC, p2pViewerBudget, suggestPreset };
export type { EncodingPreset, PresetId };

export const PRESETS: Readonly<Record<PresetId, EncodingPreset>> = SHARED_PRESETS;
export const PRESET_IDS = PRESET_ORDER;
export const DEFAULT_PRESET_ID: PresetId = 'p1080p60';

export function presetById(id: PresetId): EncodingPreset {
  return PRESETS[id];
}

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === 'string' && (PRESET_ORDER as readonly string[]).includes(value);
}

/**
 * Degradação automática por pressão de CPU.
 *
 * `qualityLimitationReason === 'cpu'` sustentado significa encode em software,
 * e nenhuma configuração de bitrate conserta isso — só codificar MENOS PIXEL.
 * Desce um degrau por vez; do último, não desce mais (a UI avisa em vez de
 * fingir que resolveu).
 *
 * A escada anda apenas por `SIXTY_FPS_PRESETS`, e não pelo `PRESET_ORDER`
 * inteiro. `p720p30` fecha a ordem de exibição mas tem a mesma resolução do
 * `p720p60eco` — descer até ele por pressão de CPU cortaria o framerate pela
 * metade sem tirar um pixel do encoder, exatamente o que
 * `maintain-framerate` e a R5 proíbem. Ele é degrau de UPLOAD, não de CPU.
 */
export function nextPresetOnCpuPressure(current: PresetId): PresetId | null {
  const index = SIXTY_FPS_PRESETS.indexOf(current);
  if (index === -1) return null; // já está fora da escada de CPU
  return SIXTY_FPS_PRESETS[index + 1] ?? null;
}

/** Traduz o preset para o pedido genérico que o transporte entende. */
export function toPublishRequest(
  preset: EncodingPreset,
  video: MediaStreamTrack,
  audio: MediaStreamTrack | null,
): PublishRequest {
  return {
    video,
    audio,
    maxBitrate: preset.main.maxBitrate,
    maxFramerate: preset.main.maxFramerate,
    layers: preset.layers.map((layer) => ({
      width: layer.width,
      height: layer.height,
      maxBitrate: layer.encoding.maxBitrate,
      maxFramerate: layer.encoding.maxFramerate,
    })),
  };
}
