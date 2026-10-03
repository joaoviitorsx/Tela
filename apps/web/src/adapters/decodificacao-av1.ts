/**
 * Este aparelho decodifica AV1 com eficiência (ADR 0035)? Pergunta uma vez ao
 * `mediaCapabilities`, no tamanho do pior caso (1080p60), e só aceita AV1 se
 * a resposta for `powerEfficient` E `smooth` — na prática, decoder de
 * hardware. Até a resposta chegar, recusa: H.264 é o piso que todo mundo
 * decodifica, e a pergunta leva milissegundos.
 *
 * `forcar`: aceita AV1 sem perguntar — só o teste de ponta a ponta, onde o
 * Chromium headless decodifica por software.
 */
export function makeAceitaCodec(forcar = false): (mimeType: string) => boolean {
  if (forcar) return () => true;
  let av1 = false;
  try {
    void navigator.mediaCapabilities
      ?.decodingInfo({
        type: 'webrtc',
        video: { contentType: 'video/AV1', width: 1920, height: 1080, framerate: 60, bitrate: 12_000_000 },
      })
      .then((r) => {
        av1 = r.supported && r.powerEfficient && r.smooth;
      })
      .catch(() => undefined);
  } catch {
    // Sem a API: fica em H.264.
  }
  return (mimeType) => mimeType.toLowerCase() !== 'video/av1' || av1;
}
