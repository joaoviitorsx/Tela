import type { AudioCapture } from '../core/ports/audio-capture.js';

/**
 * Captura de áudio do jogo no Linux.
 *
 * O WebRTC assume que áudio é voz humana. Os três processamentos que ele liga
 * por padrão destroem trilha de jogo: `echoCancellation` cancelaria o próprio
 * áudio do jogo, `noiseSuppression` trataria efeitos sonoros como ruído e
 * `autoGainControl` achataria toda a dinâmica. Os três ficam `false` (§10).
 */
const MONITOR_HINT = /monitor|loopback|tela/i;

export function makeBrowserAudioCapture(): AudioCapture {
  return {
    async listMonitors() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === 'audioinput' && MONITOR_HINT.test(device.label))
        .map((device) => ({ id: device.deviceId, label: device.label }));
    },

    async capture(deviceId) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48_000,
        },
      });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('sem trilha de áudio');
      return track;
    },
  };
}
