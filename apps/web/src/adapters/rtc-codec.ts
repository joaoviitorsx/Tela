import { VIDEO_CODEC } from '@tela/shared';

/**
 * Força H.264 na negociação.
 *
 * VP9 e AV1 comprimem melhor, mas o encode em software a 1080p60 come a CPU
 * que o jogo precisa. H.264 tem aceleração de hardware em qualquer GPU dos
 * últimos doze anos — é a única escolha compatível com o não-objetivo
 * "impacto no FPS do jogo < 5%".
 */
export function preferH264(transceiver: RTCRtpTransceiver): void {
  if (typeof RTCRtpSender.getCapabilities !== 'function') return;
  if (typeof transceiver.setCodecPreferences !== 'function') return;

  const capabilities = RTCRtpSender.getCapabilities('video');
  if (!capabilities) return;

  const wanted = `video/${VIDEO_CODEC}`;
  const preferred = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === wanted);
  if (preferred.length === 0) return;

  const rest = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() !== wanted);
  transceiver.setCodecPreferences([...preferred, ...rest]);
}

/**
 * Mata o jitter buffer adaptativo do receptor.
 *
 * Vale 50–100ms do orçamento de latência (§9) e é a diferença entre "dá pra
 * jogar junto" e "dá pra assistir". Só existe em Chromium; nos outros o campo
 * simplesmente não está lá e a atribuição não faz nada.
 */
export function minimizePlayoutDelay(receiver: RTCRtpReceiver): void {
  const target = receiver as RTCRtpReceiver & {
    playoutDelayHint?: number;
    jitterBufferTarget?: number;
  };
  if ('playoutDelayHint' in target) target.playoutDelayHint = 0;
  if ('jitterBufferTarget' in target) target.jitterBufferTarget = 0;
}
