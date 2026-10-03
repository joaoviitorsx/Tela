import { type PerfilH264, codecDoPerfil } from './perfil-h264.js';

/**
 * O codec do codificador único (ADR 0035): H.264 por padrão; AV1 quando a
 * SALA INTEIRA decodifica AV1 e esta máquina o codifica por HARDWARE. É o
 * mesmo raciocínio do piso de perfil (`perfil-h264.ts`): o quadro é um só
 * (R5), então quem decide é o espectador mais limitado.
 *
 * AV1 por software a 1080p60 pesaria no jogo — só hardware (RTX 40, Arc,
 * RX 7000). Com a cascata ligada, H.264: o anfitrião não vê o que os filhos
 * dos repassadores decodificam.
 */
export type CodecDaSala = 'h264' | 'av1';

/**
 * `negociados`: os `mimeType` que cada sender negociou (um array por sender).
 * `null` = ninguém assistindo: sem decisão.
 */
export function codecDaSala(
  negociados: readonly (readonly string[])[],
  av1NoEncoder: boolean,
  cascataAtiva: boolean,
): CodecDaSala | null {
  if (cascataAtiva || !av1NoEncoder) return negociados.length === 0 ? null : 'h264';
  if (negociados.length === 0) return null;
  return negociados.every((tipos) => tipos.some((t) => t.toLowerCase() === 'video/av1')) ? 'av1' : 'h264';
}

/**
 * A string do WebCodecs. AV1 perfil Main (0), nível 4.1 (`09`), tier Main,
 * 8 bits: cobre 1080p60.
 */
export const CODEC_AV1 = 'av01.0.09M.08';

export function codecDoEncoder(codec: CodecDaSala, perfil: PerfilH264): string {
  return codec === 'av1' ? CODEC_AV1 : codecDoPerfil(perfil);
}

/** O `mimeType` RTP de cada codec — o que a isca do sender carrega. */
export function mimeDoCodec(codec: CodecDaSala): string {
  return codec === 'av1' ? 'video/AV1' : 'video/H264';
}
