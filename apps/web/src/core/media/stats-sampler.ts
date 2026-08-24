import type { MediaStats, QualityLimitation } from '../ports/media-transport.js';

/**
 * Converte `RTCStatsReport` cru em números que a UI pode mostrar.
 *
 * Bitrate não vem pronto no WebRTC: só existe `bytesSent` acumulado desde o
 * início do fluxo. É preciso guardar a leitura anterior e derivar — por isso
 * isto é uma classe com estado, e não uma função pura.
 *
 * # Por que a contabilidade é POR FONTE
 *
 * Em mesh há um fluxo por espectador. Somar tudo num contador único parece
 * equivalente e não é: quando um espectador entra, o fluxo dele já traz bytes
 * acumulados, e a soma dá um salto que não aconteceu na rede. O HUD chegou a
 * reportar 8,2 Mbps onde o real era 1 Mbps (ADR 0006, A4).
 *
 * Guardando o contador de cada SSRC separadamente, uma fonte nova simplesmente
 * não tem leitura anterior e contribui zero no primeiro ciclo — sem pico. Uma
 * fonte que some é descartada — sem buraco nem delta negativo.
 */
export type StatsDirection = 'outbound' | 'inbound';

const LIMITATIONS: ReadonlySet<string> = new Set(['none', 'cpu', 'bandwidth', 'other']);

function asLimitation(raw: unknown): QualityLimitation {
  return typeof raw === 'string' && LIMITATIONS.has(raw) ? (raw as QualityLimitation) : 'none';
}

type Reading = { bytes: number; timestamp: number };

export class StatsSampler {
  private readonly previous = new Map<string, Reading>();

  constructor(private readonly direction: StatsDirection) {}

  reset(): void {
    this.previous.clear();
  }

  /** Um único relatório — o caso do espectador, que tem um peer só. */
  read(report: RTCStatsReport): MediaStats | null {
    return this.readMany([report]);
  }

  /** N relatórios, um por peer — o caso do transmissor em mesh. */
  readMany(reports: readonly RTCStatsReport[]): MediaStats | null {
    const wanted = this.direction === 'outbound' ? 'outbound-rtp' : 'inbound-rtp';
    const bytesField = this.direction === 'outbound' ? 'bytesSent' : 'bytesReceived';

    const current = new Map<string, Reading>();
    let fps = 0;
    let width = 0;
    let height = 0;
    let rttMs = 0;
    let limitation: QualityLimitation = 'none';
    let available: number | null = null;
    let found = false;

    reports.forEach((report, index) => {
      report.forEach((entry, key) => {
        const stat = entry as Record<string, unknown>;

        if (stat['type'] === wanted && stat['kind'] === 'video') {
          found = true;
          // SSRC identifica o fluxo de forma estável entre leituras. O índice
          // do relatório entra na chave porque dois peers podem, em teoria,
          // reportar SSRCs iguais.
          const ssrc = stat['ssrc'];
          const id = typeof ssrc === 'number' ? String(ssrc) : String(stat['id'] ?? key);
          current.set(`${index}:${id}`, {
            bytes: Number(stat[bytesField] ?? 0),
            timestamp: Number(stat['timestamp'] ?? 0),
          });

          fps = Math.max(fps, Number(stat['framesPerSecond'] ?? 0));
          width = Math.max(width, Number(stat['frameWidth'] ?? 0));
          height = Math.max(height, Number(stat['frameHeight'] ?? 0));
          const reason = asLimitation(stat['qualityLimitationReason']);
          if (reason !== 'none') limitation = reason;
        }

        /**
         * Só o par NOMINADO.
         *
         * `state === 'succeeded'` casa com todo par que já funcionou, e o ICE
         * costuma manter vários. Somar a estimativa de todos inflava a banda
         * disponível, afrouxava o teto de upload e minava justamente a defesa
         * contra bufferbloat que ele existe para dar.
         *
         * `!== false` e não `=== true`: descarta o que o navegador diz não ser
         * nominado, e tolera o navegador que não reporta o campo. Exigir
         * `true` deixaria a estimativa em zero onde ele falta, e sem
         * estimativa o teto de upload nunca age.
         */
        if (
          stat['type'] === 'candidate-pair' &&
          stat['state'] === 'succeeded' &&
          stat['nominated'] !== false
        ) {
          // O PIOR RTT, não o melhor: o melhor esconderia o amigo com problema.
          rttMs = Math.max(rttMs, Math.round(Number(stat['currentRoundTripTime'] ?? 0) * 1000));

          // Somado entre peers: em mesh cada conexão estima a própria fatia, e
          // o que interessa é o total que sai do link de casa.
          const banda = Number(stat['availableOutgoingBitrate'] ?? 0);
          if (banda > 0) available = (available ?? 0) + banda;
        }
      });
    });

    if (!found) return null;

    let bitrateBps = 0;
    for (const [id, reading] of current) {
      const before = this.previous.get(id);
      if (before === undefined) continue; // fonte nova: sem delta, sem pico
      const deltaBytes = reading.bytes - before.bytes;
      const deltaSeconds = (reading.timestamp - before.timestamp) / 1000;
      if (deltaBytes > 0 && deltaSeconds > 0) {
        bitrateBps += Math.round((deltaBytes * 8) / deltaSeconds);
      }
    }

    // Substitui o mapa inteiro: fonte que sumiu não deixa resíduo.
    this.previous.clear();
    for (const [id, reading] of current) this.previous.set(id, reading);

    return { fps: Math.round(fps), bitrateBps, rttMs, limitation, width, height, availableBps: available };
  }
}
