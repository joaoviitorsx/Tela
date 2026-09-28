import type { QuadroNeutro } from '../core/ports/quadro-neutro.js';

/**
 * Quadro neutro desenhado num canvas pequeno (480×270), a 2 fps.
 *
 * Pequeno e lento de propósito: a pausa roda na máquina do jogo, e um quadro
 * parado não pede mais que isso. Redesenha a cada 500 ms porque o
 * `captureStream` do Chrome só emite quadro quando o canvas muda — sem isso o
 * receptor ficaria com um único quadro e o vigia de mídia o daria por morto.
 */
export function makeCanvasQuadroNeutro(): QuadroNeutro {
  let trilha: MediaStreamTrack | null = null;
  let relogio: number | null = null;

  return {
    abrir() {
      if (typeof document === 'undefined') return null;
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 270;
      const ctx = canvas.getContext('2d');
      if (ctx === null || typeof canvas.captureStream !== 'function') return null;

      let tique = 0;
      const desenhar = () => {
        tique += 1;
        ctx.fillStyle = '#0b0c0e';
        ctx.fillRect(0, 0, 480, 270);
        ctx.fillStyle = '#f2a93b';
        ctx.font = '600 22px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('TRANSMISSÃO PAUSADA', 240, 132);
        ctx.fillStyle = '#8a8272';
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillText('volta em instantes', 240, 160);
        // Um pixel que alterna: força o quadro novo sem mudar o que se vê.
        ctx.fillStyle = tique % 2 === 0 ? '#0b0c0e' : '#0c0d0f';
        ctx.fillRect(0, 0, 1, 1);
      };
      desenhar();
      relogio = window.setInterval(desenhar, 500);
      trilha = canvas.captureStream(2).getVideoTracks()[0] ?? null;
      return trilha;
    },

    fechar() {
      if (relogio !== null) window.clearInterval(relogio);
      relogio = null;
      trilha?.stop();
      trilha = null;
    },
  };
}
