/**
 * Presets de encoding.
 *
 * REGRA INEGOCIÁVEL (AGENTS.md R5): duas camadas de simulcast, nunca três.
 * Cada camada é um encoder rodando na mesma máquina que o jogo. Três encoders
 * 1080p60 derrubam o FPS do jogo. Duas cobrem os dois cenários reais que
 * importam — fibra e móvel — com metade do custo de CPU.
 */

export type LayerEncoding = {
  readonly maxBitrate: number;
  readonly maxFramerate: number;
};

export type SimulcastLayer = {
  readonly width: number;
  readonly height: number;
  readonly encoding: LayerEncoding;
};

export type PresetId = 'p1080p60' | 'p720p60' | 'p720p60eco' | 'p720p30';

export type EncodingPreset = {
  readonly id: PresetId;
  readonly label: string;
  /** Texto curto que a UI mostra abaixo do rótulo. Fala de rede, não de pixel. */
  readonly hint: string;
  /** Upstream total aproximado com as duas camadas, em bits/s. Base do orçamento P2P. */
  readonly upstreamBps: number;
  readonly main: LayerEncoding & { readonly priority: 'high' };
  readonly layers: readonly [SimulcastLayer, SimulcastLayer];
};

export const PRESET_1080P60: EncodingPreset = {
  id: 'p1080p60',
  label: '1080p60',
  hint: 'Fibra. ~8 Mbps de subida por espectador.',
  upstreamBps: 11_000_000,
  main: { maxBitrate: 8_000_000, maxFramerate: 60, priority: 'high' },
  layers: [
    { width: 1920, height: 1080, encoding: { maxBitrate: 8_000_000, maxFramerate: 60 } },
    { width: 1280, height: 720, encoding: { maxBitrate: 3_000_000, maxFramerate: 30 } },
  ],
};

export const PRESET_720P60: EncodingPreset = {
  id: 'p720p60',
  label: '720p60',
  hint: 'Conexão comum. ~4 Mbps por espectador.',
  upstreamBps: 5_200_000,
  main: { maxBitrate: 4_000_000, maxFramerate: 60, priority: 'high' },
  layers: [
    { width: 1280, height: 720, encoding: { maxBitrate: 4_000_000, maxFramerate: 60 } },
    { width: 854, height: 480, encoding: { maxBitrate: 1_200_000, maxFramerate: 30 } },
  ],
};

/**
 * Terceira opção, para upload apertado ou vários espectadores em P2P.
 *
 * Continua 60fps: a regra do produto é perder resolução antes de perder
 * framerate, e gameplay a 30fps é um produto diferente. O que cai é bitrate.
 */
export const PRESET_720P60_ECO: EncodingPreset = {
  id: 'p720p60eco',
  label: '720p60 econômico',
  hint: 'Upload apertado ou muita gente assistindo. ~2,5 Mbps.',
  upstreamBps: 3_300_000,
  main: { maxBitrate: 2_500_000, maxFramerate: 60, priority: 'high' },
  layers: [
    { width: 1280, height: 720, encoding: { maxBitrate: 2_500_000, maxFramerate: 60 } },
    { width: 854, height: 480, encoding: { maxBitrate: 800_000, maxFramerate: 30 } },
  ],
};

/**
 * Último recurso, e o ÚNICO preset que abre mão dos 60fps.
 *
 * A regra do produto é perder resolução antes de framerate, e gameplay a 30fps
 * é uma experiência diferente — por isso este degrau só existe abaixo de
 * ~3,5 Mbps de upload disponível, onde a alternativa não é "60fps pior", é
 * "não transmitir". Changeset 001 §7.3 o exige; ADR 0004 registra a ressalva.
 *
 * `degradationPreference: 'maintain-framerate'` continua valendo DENTRO dele:
 * uma vez em 30fps, a adaptação em tempo real ainda prefere borrar a travar.
 */
export const PRESET_720P30: EncodingPreset = {
  id: 'p720p30',
  label: '720p30',
  hint: 'Upload muito limitado. ~1,8 Mbps. Único preset abaixo de 60fps.',
  upstreamBps: 2_500_000,
  main: { maxBitrate: 1_800_000, maxFramerate: 30, priority: 'high' },
  layers: [
    { width: 1280, height: 720, encoding: { maxBitrate: 1_800_000, maxFramerate: 30 } },
    { width: 854, height: 480, encoding: { maxBitrate: 700_000, maxFramerate: 30 } },
  ],
};

export const PRESETS = {
  p1080p60: PRESET_1080P60,
  p720p60: PRESET_720P60,
  p720p60eco: PRESET_720P60_ECO,
  p720p30: PRESET_720P30,
} as const;

/**
 * Ordem de exibição e de degradação: melhor primeiro. A UI e a queda automática
 * por CPU iteram nisto, não em `Object.keys` — ordem de chave de objeto é
 * detalhe de runtime, não contrato.
 */
export const PRESET_ORDER: readonly PresetId[] = [
  'p1080p60',
  'p720p60',
  'p720p60eco',
  'p720p30',
];

/** Presets que preservam 60fps. `p720p30` é a única exceção deliberada. */
export const SIXTY_FPS_PRESETS: readonly PresetId[] = ['p1080p60', 'p720p60', 'p720p60eco'];

/** Codec único. VP9/AV1 comprimem melhor mas não têm HW encode universal. */
export const VIDEO_CODEC = 'h264' as const;

/** Perder resolução, nunca framerate. */
export const DEGRADATION_PREFERENCE = 'maintain-framerate' as const;

/** Sem isso o Chrome trata a captura como 'detail' e gameplay vira slideshow. */
export const CONTENT_HINT = 'motion' as const;

/**
 * Orçamento de upstream no modo P2P (self-host caseiro).
 *
 * No modo SFU o transmissor sobe UMA vez (main + camada baixa) e o servidor
 * replica. No modo P2P o transmissor sobe N vezes — uma por espectador — e
 * roda N encoders. O gargalo deixa de ser o servidor e passa a ser a máquina
 * e o link de casa, exatamente os recursos que o jogo precisa.
 *
 * Ver docs/adr/0002-transporte-p2p-self-host.md.
 */
export const P2P_LIMITS = {
  /** Teto duro no browser: acima disso são N encoders 1080p60 concorrendo com o jogo. */
  maxViewersBrowser: 3,
  /** Fração do upstream medido que pode ser usada — o resto é folga anti-bufferbloat. */
  uplinkHeadroom: 0.7,
} as const;

/**
 * Quantos espectadores o upstream aguenta em P2P, dado o preset.
 * `uplinkBitsPerSecond` é a capacidade de SUBIDA medida ou informada.
 */
export function p2pViewerBudget(
  uplinkBitsPerSecond: number,
  preset: EncodingPreset,
): number {
  // Medição de banda falha. Quando falha, entrega NaN ou Infinity — e um NaN
  // que atravessa `Math.min` sai NaN do outro lado, vira `maxViewers: NaN` na
  // UI e transforma um erro de medição num teto de espectadores sem sentido.
  if (!Number.isFinite(uplinkBitsPerSecond) || uplinkBitsPerSecond <= 0) return 0;
  const usable = uplinkBitsPerSecond * P2P_LIMITS.uplinkHeadroom;
  const perViewer = preset.main.maxBitrate;
  const byBandwidth = Math.floor(usable / perViewer);
  return Math.max(0, Math.min(byBandwidth, P2P_LIMITS.maxViewersBrowser));
}

/**
 * Melhor preset que cabe num upstream, para sugerir em vez de deixar o usuário
 * adivinhar.
 *
 * A escada desce por RESOLUÇÃO e BITRATE primeiro, e só toca no framerate no
 * último degrau. É por isso que `p720p60eco` fica entre `p720p60` e `p720p30`:
 * a ~3,5 Mbps por espectador ainda dá para manter 60fps, e manter é a regra.
 */
export function suggestPreset(uplinkBitsPerSecond: number, viewers: number): PresetId {
  // Sem medição confiável, sugere o degrau mais conservador em vez de chutar
  // alto: errar para baixo custa nitidez, errar para cima custa a transmissão.
  if (!Number.isFinite(uplinkBitsPerSecond) || uplinkBitsPerSecond <= 0) return 'p720p30';
  const budget = uplinkBitsPerSecond * P2P_LIMITS.uplinkHeadroom;
  const perViewer = budget / Math.max(1, viewers);
  if (perViewer >= PRESET_1080P60.main.maxBitrate) return 'p1080p60';
  if (perViewer >= PRESET_720P60.main.maxBitrate) return 'p720p60';
  if (perViewer >= PRESET_720P60_ECO.main.maxBitrate) return 'p720p60eco';
  return 'p720p30';
}
