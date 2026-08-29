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
   * `hardware`, `software` ou `—`.
   *
   * O Chromium reporta `ExternalEncoder` quando o encode roda na GPU, e o nome
   * da biblioteca (`OpenH264`, `libvpx`) quando roda na CPU. Era a única
   * pergunta de desempenho que só se respondia em `chrome://gpu`.
   */
  readonly encoder: string;
};

/**
 * Nomes que o Chromium usa para o caminho de HARDWARE.
 *
 * `ExternalEncoder` é o genérico; os outros aparecem em versões e plataformas
 * específicas. Qualquer outra coisa é software, e software a 1080p60 é
 * exatamente a CPU que o jogo precisa.
 */
const EM_HARDWARE = /external|hardware|nvenc|videotoolbox|mediafoundation|vaapi|qsv|amf/i;

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
      encoder: impl === null ? '—' : EM_HARDWARE.test(impl) ? 'hardware' : 'software',
    };
  }, [stats]);
}
