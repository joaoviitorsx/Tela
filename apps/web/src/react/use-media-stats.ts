import { useMemo } from 'react';
import type { MediaStats } from '../core/ports/media-transport.js';

export type ReadableStats = {
  readonly resolution: string;
  readonly fps: string;
  readonly bitrate: string;
  readonly rtt: string;
  readonly warning: string | null;
};

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
      return { resolution: '—', fps: '—', bitrate: '—', rtt: '—', warning: null };
    }
    return {
      resolution: stats.width > 0 ? `${stats.width}×${stats.height}` : '—',
      fps: stats.fps > 0 ? `${stats.fps}fps` : '—',
      bitrate: stats.bitrateBps > 0 ? `${(stats.bitrateBps / 1_000_000).toFixed(1)} Mbps` : '—',
      rtt: stats.rttMs > 0 ? `${stats.rttMs}ms` : '—',
      warning: MOTIVOS[stats.limitation] ?? null,
    };
  }, [stats]);
}
