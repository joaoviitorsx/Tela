import { BPP_PISO } from '@tela/shared';
import { useMemo } from 'react';
import type { MediaStats } from '../core/ports/media-transport.js';

export type ReadableStats = {
  readonly resolution: string;
  readonly fps: string;
  readonly bitrate: string;
  readonly rtt: string;
  readonly warning: string | null;
  /** Bits por pixel, formatado. O número que prevê a imagem borrada. */
  readonly bpp: string;
  /** `true` quando os bits por pixel caíram abaixo do piso de 0,10. */
  readonly bppBaixo: boolean;
  /**
   * `hardware`, `software`, `desconhecido` ou `—`.
   *
   * No transmissor vem de `encoderImplementation`; no espectador, de
   * `decoderImplementation` — são campos diferentes, e ler só o primeiro nos
   * dois sentidos deixava quem assiste sem resposta nenhuma. Decode em
   * software é uma das causas de travadinha do lado de quem assiste.
   *
   * Era a única pergunta de desempenho que só se respondia em `chrome://gpu`.
   */
  readonly encoder: string;
  /** QP médio formatado, ou `—`. Acima de 37 o Chromium derruba resolução. */
  readonly qp: string;
  /** `true` quando o QP passou do limiar em que o quality scaler age. */
  readonly qpAlto: boolean;
};

/**
 * Nomes que o Chromium usa para os codecs de SOFTWARE. Lista fechada, e a
 * inversão é o conserto.
 *
 * Era uma lista de permissão de nomes de hardware, com tudo o mais caindo em
 * "software". Duas formas de mentir:
 *
 * - o MediaCodec do Android reporta `OMX.qcom.video.encoder.avc` ou
 *   `c2.qti.avc.encoder`, que não casam com nada da lista — o painel dizia
 *   "encode em software" E acendia alerta, mandando o usuário caçar um
 *   problema que não existia;
 * - `SimulcastEncoderAdapter (ExternalEncoder, libvpx, libvpx)` casava
 *   "external" e era vendido como hardware puro.
 *
 * Software é o conjunto conhecido e pequeno; hardware é tudo que tem nome de
 * driver. O que não se reconhece vira `desconhecido`, não uma acusação.
 */
/**
 * O limiar em que o `QualityScaler` do libwebrtc começa a derrubar resolução,
 * para H.264 na escala 0–51. Publicado em `h264_encoder_impl.cc`.
 */
const QP_LIMIAR = 37;

const EM_SOFTWARE = /libvpx|libaom|openh264|ffmpeg|dav1d|libx264/i;

const MOTIVOS: Record<MediaStats['limitation'], string | null> = {
  none: null,
  // Diagnóstico honesto, não eufemismo. O usuário merece saber que o problema
  // é a máquina dele e não "instabilidade".
  cpu: 'CPU no limite — reduzindo qualidade',
  bandwidth: 'Rede no limite — reduzindo qualidade',
  other: 'Reduzindo qualidade',
};

/** Formata para o HUD. Sem estado, sem efeito — só apresentação. */
export function useMediaStats(stats: MediaStats | null): ReadableStats {
  return useMemo(() => {
    if (stats === null) {
      return {
        resolution: '—',
        fps: '—',
        bitrate: '—',
        rtt: '—',
        warning: null,
        bpp: '—',
        bppBaixo: false,
        encoder: '—',
        qp: '—',
        qpAlto: false,
      };
    }
    const impl = stats.encoderImplementation;
    return {
      resolution: stats.width > 0 ? `${stats.width}×${stats.height}` : '—',
      fps: stats.fps > 0 ? `${stats.fps}fps` : '—',
      bitrate: stats.bitrateBps > 0 ? `${(stats.bitrateBps / 1_000_000).toFixed(1)} Mbps` : '—',
      rtt: stats.rttMs > 0 ? `${stats.rttMs}ms` : '—',
      warning: MOTIVOS[stats.limitation] ?? null,
      bpp: stats.bpp > 0 ? stats.bpp.toFixed(3).replace('.', ',') : '—',
      // Só acusa com leitura de verdade: `0` é ausência de medida, não fome.
      bppBaixo: stats.bpp > 0 && stats.bpp < BPP_PISO,
      encoder: impl === null ? '—' : EM_SOFTWARE.test(impl) ? 'software' : 'hardware',
      qp: stats.qp === null ? '—' : stats.qp.toFixed(0),
      // `kHighH264QpThreshold = 37` no libwebrtc: é onde o quality scaler age.
      qpAlto: stats.qp !== null && stats.qp >= QP_LIMIAR,
    };
  }, [stats]);
}
