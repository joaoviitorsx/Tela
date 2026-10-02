/**
 * Do `captureTimestamp` do RTP ao atraso real de um quadro, sem câmera.
 *
 * # De onde vem o instante de captura
 *
 * `requestVideoFrameCallback` promete `captureTime`, mas o Chromium não o
 * preenche para vídeo remoto (medido: 0 de 120 quadros mesmo com
 * `abs-capture-time` negociada). A extensão chega, porém: o mesmo dado sai de
 * `RTCRtpReceiver.getSynchronizationSources()` como `captureTimestamp` — o
 * instante de captura no relógio de PAREDE do transmissor, em NTP — junto do
 * `rtpTimestamp` do último pacote.
 *
 * Um ponto basta para os demais: o relógio RTP de vídeo é de 90 kHz e o
 * transmissor carimba capturas espaçadas por ele, então
 *
 *     captura(quadro) = captura(ref) + (rtp(quadro) − rtp(ref)) / 90
 *
 * É a mesma conta que o receptor faz internamente, e vale em janelas de
 * segundos — a referência é renovada a cada tique de estatísticas.
 *
 * # O relógio do transmissor não é o nosso
 *
 * `captureTimestamp` NÃO é convertido para o relógio de quem recebe: duas
 * máquinas com NTP desajustado diferem em dezenas de ms, ou segundos. A
 * conversão sai do RTCP, que o navegador já recebe: todo Sender Report traz o
 * relógio de parede do transmissor (`remoteTimestamp`) e o stats registra
 * quando ele chegou aqui (`timestamp`). A diferença é offset MAIS o atraso
 * de ida; descontamos RTT/2 (ida e volta simétricas — o erro é metade da
 * assimetria do caminho, e é o limite honesto desta medida) e tiramos a
 * mediana das últimas leituras para que um SR atrasado na fila não mande.
 */

/** Relógio de vídeo RTP: 90 kHz → 90 ticks por ms. */
const TICKS_POR_MS = 90;

/** Offset NTP (1900) → Unix (1970) em ms. */
const NTP_PARA_UNIX_MS = 2_208_988_800_000;

/**
 * Referência maior que isto desde a última leitura não serve: o fluxo
 * mudou de linha do tempo (reconexão) e extrapolar viraria ruído.
 */
const IDADE_MAXIMA_MS = 10_000;

/** Quantos offsets de SR guardar. Um SR a cada 1–5 s → dezenas de segundos. */
const LEITURAS_DE_OFFSET = 15;

/** O que o transporte lê, cru, num instante. */
export type ReferenciaDeCaptura = {
  /** `rtpTimestamp` (32 bits) do pacote a que `captureTimestamp` se refere. */
  readonly rtpTimestamp: number;
  /** `captureTimestamp` como o navegador entrega: NTP ou Unix, em ms. */
  readonly captureTimestamp: number;
  /**
   * Um Sender Report: relógio do transmissor quando o emitiu, quando chegou
   * aqui (ambos Unix, ms) e o RTT do caminho. `null` sem SR ainda — sem ele o
   * offset é desconhecido e o atraso NÃO é anunciado como medida.
   */
  readonly relogio: {
    readonly remotoMs: number;
    readonly recebidoMs: number;
    readonly rttMs: number;
  } | null;
};

/** Normaliza para Unix ms. Valores acima de 2,5e12 são NTP (1900). */
export function paraUnixMs(captureTimestamp: number): number {
  return captureTimestamp > 2.5e12 ? captureTimestamp - NTP_PARA_UNIX_MS : captureTimestamp;
}

/** Diferença de 32 bits com sinal, tolerante a wrap-around do `rtpTimestamp`. */
export function diferencaRtp(a: number, b: number): number {
  return ((a - b) | 0);
}

export function mediana(valores: readonly number[]): number | null {
  if (valores.length === 0) return null;
  const v = [...valores].sort((x, y) => x - y);
  const meio = v.length >> 1;
  const m = v.length % 2 === 1 ? v[meio] : ((v[meio - 1] ?? 0) + (v[meio] ?? 0)) / 2;
  return m ?? null;
}

export class RelogioDeCaptura {
  private ref: { rtp: number; captureUnixMs: number; lidoEm: number } | null = null;
  private readonly offsets: number[] = [];
  private ultimoSr = -1;

  /** Nova leitura do transporte. `agora` é o relógio Unix local, em ms. */
  observar(leitura: ReferenciaDeCaptura, agora: number): void {
    if (Number.isFinite(leitura.captureTimestamp) && Number.isFinite(leitura.rtpTimestamp)) {
      this.ref = {
        rtp: leitura.rtpTimestamp,
        captureUnixMs: paraUnixMs(leitura.captureTimestamp),
        lidoEm: agora,
      };
    }
    const r = leitura.relogio;
    if (r !== null && r.remotoMs !== this.ultimoSr) {
      this.ultimoSr = r.remotoMs;
      const rtt = Number.isFinite(r.rttMs) && r.rttMs >= 0 ? r.rttMs : 0;
      const offset = r.recebidoMs - r.remotoMs - rtt / 2;
      if (Number.isFinite(offset)) {
        this.offsets.push(offset);
        if (this.offsets.length > LEITURAS_DE_OFFSET) this.offsets.shift();
      }
    }
  }

  /** Quanto o relógio de lá está ADIANTADO em relação ao daqui (ms), se sabido. */
  get offsetMs(): number | null {
    return mediana(this.offsets);
  }

  /**
   * Atraso do quadro identificado por `rtpTimestamp`, exibido em `exibicaoMs`
   * (Unix, relógio local). `null` quando faltar referência, offset, ou a
   * referência for velha demais — nunca um número inventado.
   */
  latenciaMs(rtpTimestamp: number, exibicaoMs: number, agora: number): number | null {
    const ref = this.ref;
    const offset = this.offsetMs;
    if (ref === null || offset === null) return null;
    if (agora - ref.lidoEm > IDADE_MAXIMA_MS) return null;
    if (!Number.isFinite(rtpTimestamp) || !Number.isFinite(exibicaoMs)) return null;
    const capturaLocal =
      ref.captureUnixMs + diferencaRtp(rtpTimestamp, ref.rtp) / TICKS_POR_MS + offset;
    const ms = exibicaoMs - capturaLocal;
    return Number.isFinite(ms) ? ms : null;
  }

  reset(): void {
    this.ref = null;
    this.offsets.length = 0;
    this.ultimoSr = -1;
  }
}
