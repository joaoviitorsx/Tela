/**
 * A trilha que a sessão recebe quando quem captura é o `tela-captura`
 * (`captura-desktop.ts`): um canvas parado, com um cartaz, capturado a 0 fps.
 *
 * Ela existe porque a `BroadcastSession` e o transporte "um encode" esperam
 * uma `MediaStreamTrack` para publicar, pôr na prévia, parar e observar o
 * `ended` — mas a imagem nunca passa pelo Chromium nesse caminho. Um quadro
 * só, desenhado uma vez: a prévia mostra o cartaz em vez de preto, e não
 * custa nada depois (`captureStream(0)` só emite em `requestFrame`).
 *
 * 320×180 e não 1080p: o tamanho real da fonte vem do processo
 * (`CodificadorExterno.fonte()`), e um canvas 1080p seria 8 MB parados.
 */
export function criarTrilhaFantasma(): MediaStreamTrack {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx !== null) {
    ctx.fillStyle = '#0b0c0e';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#f2a93b';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('CAPTURA PELO SISTEMA', 160, 84);
    ctx.fillStyle = '#8a8272';
    ctx.font = '12px monospace';
    ctx.fillText('NVENC · a prévia não passa por aqui', 160, 110);
  }
  const trilha = canvas.captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (trilha === undefined) throw new Error('canvas sem trilha para a captura nativa');
  trilha.requestFrame();
  return trilha;
}
