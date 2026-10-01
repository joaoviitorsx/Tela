/**
 * O navegador consegue rodar o "um encode, N envios" (D0b)?
 *
 * O transporte de `encode-once-transport.ts` precisa de três peças que só o
 * Chromium entrega hoje: ler os quadros da captura (`MediaStreamTrackProcessor`),
 * codificar fora do WebRTC (`VideoEncoder`, WebCodecs) e trocar o conteúdo de
 * cada quadro-isca no caminho de saída (`RTCRtpScriptTransform`). Faltando
 * uma, o transporte não monta — e o mesh puro, que codifica uma vez por
 * peer, continua funcionando em qualquer navegador com WebRTC.
 *
 * A diferença não é só de CPU: é de CAPACIDADE. Quem tem as três peças serve
 * `P2P_LIMITS.maxViewers`; quem não tem, `maxViewersSemUmEncode`. É este
 * teste que decide qual dos dois números o transmissor declara ao servidor.
 *
 * Puro de propósito: recebe o objeto global em vez de ler `window`, para o
 * teste provar os dois caminhos sem navegador.
 */
export const REQUISITOS_UM_ENCODE = [
  'MediaStreamTrackProcessor',
  'VideoEncoder',
  'RTCRtpScriptTransform',
] as const;

export type RequisitoUmEncode = (typeof REQUISITOS_UM_ENCODE)[number];

export function suportaUmEncode(globais: object): boolean {
  const lido = globais as Readonly<Record<string, unknown>>;
  return REQUISITOS_UM_ENCODE.every((nome) => typeof lido[nome] === 'function');
}

/**
 * O `VideoEncoder` existir não garante H.264: Chromium de distribuição sem os
 * codecs proprietários tem a API e recusa o perfil. Pergunta ao encoder com a
 * configuração de verdade (1080p60 realtime, Annex B). Falha ou recusa =
 * `false`: o transmissor fica no mesh, em vez de quebrar ao ir ao ar.
 */
export async function codificaH264(encoder: unknown, codec: string): Promise<boolean> {
  const ctor = encoder as { isConfigSupported?: (c: VideoEncoderConfig) => Promise<VideoEncoderSupport> };
  if (typeof ctor?.isConfigSupported !== 'function') return false;
  try {
    const r = await ctor.isConfigSupported({
      codec,
      width: 1920,
      height: 1080,
      bitrate: 12_000_000,
      framerate: 60,
      latencyMode: 'realtime',
      avc: { format: 'annexb' },
    });
    return r.supported === true;
  } catch {
    return false;
  }
}

/** Quais peças faltam — para o diagnóstico dizer POR QUE este navegador para em poucos. */
export function requisitosAusentes(globais: object): readonly RequisitoUmEncode[] {
  const lido = globais as Readonly<Record<string, unknown>>;
  return REQUISITOS_UM_ENCODE.filter((nome) => typeof lido[nome] !== 'function');
}
