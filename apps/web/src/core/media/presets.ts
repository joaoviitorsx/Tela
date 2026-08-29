import {
  BPP_PISO,
  BPP_TETO,
  CONTENT_HINT,
  DEGRADATION_PREFERENCE,
  type EncodingPreset,
  FRAMERATE_POR_PRIORIDADE,
  PRESET_ORDER,
  PRESETS as SHARED_PRESETS,
  type PresetId,
  type Prioridade,
  SIXTY_FPS_PRESETS,
  VIDEO_CODEC,
  bitsPorPixel,
  p2pViewerBudget,
  presetForBitrate,
  suggestPreset,
} from '@tela/shared';

export {
  BPP_PISO,
  BPP_TETO,
  CONTENT_HINT,
  DEGRADATION_PREFERENCE,
  FRAMERATE_POR_PRIORIDADE,
  VIDEO_CODEC,
  bitsPorPixel,
  p2pViewerBudget,
  presetForBitrate,
  suggestPreset,
};
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

/**
 * Um degrau PARA CIMA, quando o aperto passou.
 *
 * A escada só descia. Dez segundos de vizinho baixando um jogo tiravam o
 * usuário de 1080p60 e ele ficava em 2,5 Mbps pelo resto da sessão, sem que
 * nada na tela explicasse por quê — o "embaçou e não voltou".
 *
 * `teto` é o preset que o usuário ESCOLHEU: a recuperação devolve o que a
 * degradação tirou e para ali. Subir além disso seria decidir por ele.
 */
export function previousPresetOnRecovery(current: PresetId, teto: PresetId): PresetId | null {
  const atual = SIXTY_FPS_PRESETS.indexOf(current);
  const limite = SIXTY_FPS_PRESETS.indexOf(teto);
  if (atual === -1 || limite === -1 || atual <= limite) return null;
  return SIXTY_FPS_PRESETS[atual - 1] ?? null;
}

/**
 * O transporte recebe o preset inteiro, não uma tradução.
 *
 * Antes havia um `toPublishRequest` que achatava o preset em camadas de
 * simulcast. Em mesh não há simulcast: uma conexão tem um receptor, e o
 * controle de congestionamento dela já adapta o encoding àquele espectador.
 * O que resta é aplicar bitrate e framerate iguais em todos os senders
 * (AGENTS.md R5, quarta regra) — trabalho do `MeshTopology`.
 */

/**
 * O PIOR dos dois degraus — o que a escada precisa quando há mais de uma
 * pressão em jogo.
 *
 * A sessão tem três fontes de restrição ao mesmo tempo: o que o usuário
 * escolheu, o que a CPU sustenta e o que o orçamento de banda paga. Elas não
 * se somam nem se substituem; a que aperta mais é a que vale. Antes havia um
 * `presetId` mutável só, e a última fonte a escrever nele apagava as outras —
 * era como o produto acabava pedindo 1080p60 num orçamento de 3 Mbps.
 *
 * `PRESET_ORDER` vai do melhor para o pior, então o maior índice ganha.
 */
export function menorPreset(a: PresetId, b: PresetId): PresetId {
  return PRESET_ORDER.indexOf(a) >= PRESET_ORDER.indexOf(b) ? a : b;
}

/**
 * O degrau que um orçamento de banda paga, com bits por pixel honestos.
 *
 * É a ponte que faltava entre o teto de upload e a resolução. O teto sempre
 * cortou BITS; nada cortava PIXEL, e 1920×1080@60 com o orçamento de 480p é
 * exatamente a imagem borrada que a ADR 0015 documenta.
 */
export function presetParaOrcamento(bps: number, prioridade: Prioridade): PresetId {
  return presetForBitrate(bps, FRAMERATE_POR_PRIORIDADE[prioridade]);
}
