import type { QualityLimitation, TransportStats } from '../ports/media-transport.js';

/**
 * Converte `RTCStatsReport` cru em números que a UI pode mostrar.
 *
 * Bitrate não vem pronto no WebRTC: só existe `bytesSent` acumulado. É preciso
 * guardar a leitura anterior e derivar. Por isso isto é uma classe com estado,
 * e não uma função pura.
 */
export type StatsDirection = 'outbound' | 'inbound';

type Sample = { bytes: number; timestamp: number };

const LIMITATIONS: ReadonlySet<string> = new Set(['none', 'cpu', 'bandwidth', 'other']);

function asLimitation(raw: unknown): QualityLimitation {
  return typeof raw === 'string' && LIMITATIONS.has(raw) ? (raw as QualityLimitation) : 'none';
}

export class StatsSampler {
  private previous: Sample | null = null;

  constructor(private readonly direction: StatsDirection) {}

  reset(): void {
    this.previous = null;
  }

  /** `null` quando o report ainda não tem RTP do tipo esperado. */
  read(report: RTCStatsReport): TransportStats | null {
    const wanted = this.direction === 'outbound' ? 'outbound-rtp' : 'inbound-rtp';

    let bytes = 0;
    let timestamp = 0;
    let fps = 0;
    let width = 0;
    let height = 0;
    let limitation: QualityLimitation = 'none';
    let rttMs = 0;
    let found = false;

    report.forEach((entry) => {
      const stat = entry as Record<string, unknown>;

      if (stat['type'] === wanted && stat['kind'] === 'video') {
        found = true;
        // Somatório: em P2P há um outbound-rtp por espectador, e o número
        // honesto para o HUD é o total que está saindo do link do usuário.
        bytes += Number(stat[this.direction === 'outbound' ? 'bytesSent' : 'bytesReceived'] ?? 0);
        timestamp = Math.max(timestamp, Number(stat['timestamp'] ?? 0));
        fps = Math.max(fps, Number(stat['framesPerSecond'] ?? 0));
        width = Math.max(width, Number(stat['frameWidth'] ?? 0));
        height = Math.max(height, Number(stat['frameHeight'] ?? 0));
        const reason = asLimitation(stat['qualityLimitationReason']);
        if (reason !== 'none') limitation = reason;
      }

      if (stat['type'] === 'candidate-pair' && stat['state'] === 'succeeded') {
        rttMs = Math.max(rttMs, Math.round(Number(stat['currentRoundTripTime'] ?? 0) * 1000));
      }
    });

    if (!found) return null;

    let bitrateBps = 0;
    if (this.previous !== null && timestamp > this.previous.timestamp) {
      const deltaBytes = bytes - this.previous.bytes;
      const deltaSeconds = (timestamp - this.previous.timestamp) / 1000;
      if (deltaBytes >= 0 && deltaSeconds > 0) {
        bitrateBps = Math.round((deltaBytes * 8) / deltaSeconds);
      }
    }
    this.previous = { bytes, timestamp };

    return { fps: Math.round(fps), bitrateBps, rttMs, limitation, width, height };
  }
}
