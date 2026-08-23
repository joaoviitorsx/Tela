import type { CaptureError, ScreenCapture } from '../core/ports/screen-capture.js';

/**
 * `getDisplayMedia` com as opções que importam.
 *
 * `contentHint` NÃO é setado aqui — é responsabilidade da sessão em `core/`,
 * porque é regra de produto (R5) e precisa valer também no app nativo, onde
 * este adapter não existe.
 */
export function makeBrowserScreenCapture(): ScreenCapture {
  return {
    isSupported() {
      return (
        typeof navigator !== 'undefined' &&
        typeof navigator.mediaDevices?.getDisplayMedia === 'function'
      );
    },

    async request(options) {
      if (!this.isSupported()) throw 'UNSUPPORTED' satisfies CaptureError;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: options.width, max: options.width },
            height: { ideal: options.height, max: options.height },
            frameRate: { ideal: options.frameRate, max: options.frameRate },
          },
          // Windows/Chrome entrega áudio do sistema por aqui. Linux e macOS
          // ignoram e o áudio vem por trilha separada (§10).
          audio: options.systemAudio,
          // Não padronizados, suportados em Chromium.
          surfaceSwitching: 'include',
          selfBrowserSurface: 'exclude',
          systemAudio: options.systemAudio ? 'include' : 'exclude',
        } as DisplayMediaStreamOptions);
      } catch {
        // O usuário fechar o picker cai aqui. É fluxo normal, não bug.
        throw 'DENIED' satisfies CaptureError;
      }

      const video = stream.getVideoTracks()[0];
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        throw 'NO_TRACK' satisfies CaptureError;
      }

      return { video, audio: stream.getAudioTracks()[0] ?? null };
    },
  };
}
