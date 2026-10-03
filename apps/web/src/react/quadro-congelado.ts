/**
 * O último quadro de um `<video>`, pequeno, para a secundária pausada não
 * ficar preta (ADR 0032). Roda uma vez, no instante da pausa — nunca por
 * quadro. `null` quando não há imagem ou o navegador recusa.
 */
export function congelarQuadro(video: HTMLVideoElement | null, largura = 480): string | null {
  if (video === null || video.videoWidth === 0 || video.videoHeight === 0) return null;
  const escala = Math.min(1, largura / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * escala);
  canvas.height = Math.round(video.videoHeight * escala);
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}
