import type { Scheduler } from '../core/ports/scheduler.js';

export function makeBrowserScheduler(): Scheduler {
  return {
    every(intervalMs, task) {
      const id = window.setInterval(task, intervalMs);
      return () => window.clearInterval(id);
    },
    after(delayMs, task) {
      const id = window.setTimeout(task, delayMs);
      return () => window.clearTimeout(id);
    },
    now: () => Date.now(),

    /**
     * "Visível" é "alguém está olhando", e a janela de picture-in-picture
     * conta (TELA-021, §10.2). Com a PiP aberta a aba fica `hidden` — é esse
     * o ponto de abrir a PiP —, e a sessão do espectador adiava a reconexão
     * como se ninguém estivesse assistindo: o vídeo da janelinha travava e
     * só voltava quando a pessoa reabria a aba.
     */
    isVisible: () =>
      typeof document === 'undefined' ||
      document.visibilityState === 'visible' ||
      (document.pictureInPictureElement ?? null) !== null,

    onVisibilityChange(handler) {
      if (typeof document === 'undefined') return () => undefined;
      document.addEventListener('visibilitychange', handler);
      // Os eventos de PiP nascem no <video> e sobem; captura para não depender disso.
      document.addEventListener('enterpictureinpicture', handler, true);
      document.addEventListener('leavepictureinpicture', handler, true);
      return () => {
        document.removeEventListener('visibilitychange', handler);
        document.removeEventListener('enterpictureinpicture', handler, true);
        document.removeEventListener('leavepictureinpicture', handler, true);
      };
    },
  };
}
