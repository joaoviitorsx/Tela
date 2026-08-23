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
    async requestPermission() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
      try {
        // Abrir e fechar na hora: o objetivo é só destravar os rótulos em
        // `enumerateDevices`, não capturar nada ainda.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        return true;
      } catch {
        return false;
      }
    },

    async listMonitors() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      const entradas = devices.filter((device) => device.kind === 'audioinput');
      const monitores = entradas.filter((device) => MONITOR_HINT.test(device.label));
      // Se nada casar com o padrão de monitor, devolve todas as entradas: um
      // sink virtual com nome inventado pelo usuário ainda precisa ser
      // escolhível, e uma lista vazia não dá saída nenhuma a ele.
      return (monitores.length > 0 ? monitores : entradas)
        .filter((device) => device.deviceId !== '')
        .map((device) => ({ id: device.deviceId, label: device.label || 'entrada sem nome' }));
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
