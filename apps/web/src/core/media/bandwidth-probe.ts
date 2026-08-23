import {
  PRESET_720P30,
  PRESET_720P60,
  PRESET_720P60_ECO,
  PRESET_1080P60,
  type EncodingPreset,
  type PresetId,
} from '@tela/shared';

/**
 * O upload do transmissor é o recurso escasso do mesh.
 *
 * Num SFU o servidor replica; aqui cada espectador consome uma cópia inteira
 * saindo da casa do usuário, disputando banda com o netcode do próprio jogo.
 * Saturar o upstream não degrada só o vídeo: enche o buffer do roteador e o
 * ping do jogo sobe junto.
 *
 * Regra pura e testável de propósito — mora em `core/`, não na UI.
 */

/**
 * Fração do upload medido que pode ser usada.
 *
 * Os 25% de folga não são conservadorismo: cobrem ACKs, jitter, o tráfego do
 * próprio jogo e a margem anti-bufferbloat. Sem eles, "cabe na conta" vira
 * "cabe até alguém dar um tiro".
 */
export const UPLOAD_HEADROOM = 0.75;

/** Teto duro. Acima disso são N encoders 1080p60 concorrendo com o jogo. */
export const MAX_PEERS = 3;

/** Quantos espectadores o upload aguenta, dado o preset. */
export function maxPeersFor(uploadMbps: number, preset: EncodingPreset): number {
  if (!Number.isFinite(uploadMbps) || uploadMbps <= 0) return 1;
  const perPeerMbps = preset.main.maxBitrate / 1_000_000;
  const usable = uploadMbps * UPLOAD_HEADROOM;
  return Math.max(1, Math.min(MAX_PEERS, Math.floor(usable / perPeerMbps)));
}

/**
 * Melhor preset que o upload comporta para UM espectador.
 *
 * A escada desce por resolução e bitrate primeiro; 720p30 é o último degrau e
 * o único abaixo de 60fps — abaixo de ~2,4 Mbps a alternativa a 30fps não é
 * "60fps pior", é não transmitir.
 */
export function selectPreset(uploadMbps: number): PresetId {
  if (!Number.isFinite(uploadMbps) || uploadMbps <= 0) return 'p720p30';
  const usable = uploadMbps * UPLOAD_HEADROOM;
  if (usable >= PRESET_1080P60.main.maxBitrate / 1_000_000) return 'p1080p60';
  if (usable >= PRESET_720P60.main.maxBitrate / 1_000_000) return 'p720p60';
  if (usable >= PRESET_720P60_ECO.main.maxBitrate / 1_000_000) return 'p720p60eco';
  return 'p720p30';
}

export type BandwidthAdvice = {
  readonly uploadMbps: number;
  readonly presetId: PresetId;
  readonly maxPeers: number;
};

const BY_ID: Record<PresetId, EncodingPreset> = {
  p1080p60: PRESET_1080P60,
  p720p60: PRESET_720P60,
  p720p60eco: PRESET_720P60_ECO,
  p720p30: PRESET_720P30,
};

/**
 * O conselho que a UI mostra: "seu upload comporta 720p60 · até 2
 * espectadores". O usuário pode ignorar — é conselho, não trava.
 */
export function adviseFor(uploadMbps: number): BandwidthAdvice {
  const presetId = selectPreset(uploadMbps);
  return {
    uploadMbps,
    presetId,
    maxPeers: maxPeersFor(uploadMbps, BY_ID[presetId]),
  };
}

/**
 * Estima o upload a partir do que o WebRTC já mediu.
 *
 * Deliberadamente NÃO é um teste de velocidade: subir um arquivo grande para
 * medir banda consumiria justamente o recurso que estamos tentando preservar,
 * e faria isso no pior momento — a abertura da transmissão. Em vez disso a
 * estimativa vem do `availableOutgoingBitrate`, que o próprio controle de
 * congestionamento calcula durante a conexão.
 *
 * Devolve `null` enquanto não houver medição — a UI mostra o conselho só
 * quando ele existe, em vez de chutar.
 */
export function estimateUploadMbps(reports: readonly RTCStatsReport[]): number | null {
  let total = 0;
  let found = false;

  for (const report of reports) {
    report.forEach((entry) => {
      const stat = entry as Record<string, unknown>;
      if (stat['type'] !== 'candidate-pair' || stat['state'] !== 'succeeded') return;
      const available = Number(stat['availableOutgoingBitrate'] ?? 0);
      if (available > 0) {
        total += available;
        found = true;
      }
    });
  }

  return found ? total / 1_000_000 : null;
}
