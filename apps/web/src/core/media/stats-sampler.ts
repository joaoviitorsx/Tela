import { bitsPorPixel } from '@tela/shared';
import type { RelatorioDePeer } from '../mesh/mesh-topology.js';
import type {
  MediaStats,
  QualityLimitation,
  RecepcaoStats,
} from '../ports/media-transport.js';

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
    return this.readMany([{ peerId: 'host', report }]);
  }

  /**
   * N relatórios, um por peer — o caso do transmissor em mesh.
   *
   * Chaveado por `peerId` e não pelo índice do array. Índice não é identidade:
   * quando um peer sai, todos os seguintes deslizam e tanto o delta de bytes
   * quanto a média por caminho são atribuídos ao peer errado por uma amostra.
   */
  readMany(entradas: readonly RelatorioDePeer[]): MediaStats | null {
    const wanted = this.direction === 'outbound' ? 'outbound-rtp' : 'inbound-rtp';
    const bytesField = this.direction === 'outbound' ? 'bytesSent' : 'bytesReceived';

    const current = new Map<string, Reading>();
    let fps = 0;
    let width = 0;
    let height = 0;
    let rttMs = 0;
    let limitation: QualityLimitation = 'none';
    let available: number | null = null;
    let pior: number | null = null;
    let paresMedidos = 0;
    let encoderImplementation: string | null = null;
    let qpSoma = 0;
    let qpQuadros = 0;
    let encodeSegundos = 0;
    let encodeQuadros = 0;

    /**
     * O lado de quem assiste. Acumuladores porque `inbound-rtp` reporta totais
     * de sessão, não taxas — e para "quantas vezes travou" o total É a resposta.
     */
    let temRecepcao = false;
    let jbAtraso = 0;
    let jbEmitidos = 0;
    let procAtraso = 0;
    let procQuadros = 0;
    let decodeSegundos = 0;
    let congelamentos = 0;
    let tempoCongeladoS = 0;
    let quadrosDescartados = 0;
    let pacotesPerdidos = 0;
    let pedidosDeKeyframe = 0;
    let decoder: string | null = null;
    let found = false;

    const availablePorPeer: Record<string, number> = {};

    entradas.forEach(({ peerId, report }) => {
      report.forEach((entry, key) => {
        const stat = entry as Record<string, unknown>;

        if (stat['type'] === wanted && stat['kind'] === 'video') {
          found = true;
          // SSRC identifica o fluxo de forma estável entre leituras. O índice
          // do relatório entra na chave porque dois peers podem, em teoria,
          // reportar SSRCs iguais.
          const ssrc = stat['ssrc'];
          const id = typeof ssrc === 'number' ? String(ssrc) : String(stat['id'] ?? key);
          current.set(`${peerId}:${id}`, {
            bytes: Number(stat[bytesField] ?? 0),
            timestamp: Number(stat['timestamp'] ?? 0),
          });

          fps = Math.max(fps, Number(stat['framesPerSecond'] ?? 0));
          width = Math.max(width, Number(stat['frameWidth'] ?? 0));
          height = Math.max(height, Number(stat['frameHeight'] ?? 0));
          const reason = asLimitation(stat['qualityLimitationReason']);
          if (reason !== 'none') limitation = reason;

          /**
           * O campo depende do SENTIDO, e ler o errado dava `null` para sempre.
           *
           * `outbound-rtp` traz `encoderImplementation`; `inbound-rtp` traz
           * `decoderImplementation`. Lendo só o primeiro nos dois caminhos, o
           * espectador nunca sabia se estava decodificando em hardware — e
           * decode em software é uma das causas de travadinha do lado de quem
           * assiste, exatamente o lado que reclama.
           */
          // O gatilho real do quality scaler: acima de 37 em H.264 o Chromium
          // começa a derrubar resolução sozinho.
          const somaQp = Number(stat['qpSum'] ?? 0);
          const quadros = Number(stat['framesEncoded'] ?? 0);
          if (somaQp > 0 && quadros > 0) {
            qpSoma += somaQp;
            qpQuadros += quadros;
          }

          /**
           * Quanto o encoder gasta por quadro — o substituto de
           * `encoderImplementation`, que medimos não existir no caminho de
           * captura de tela. Acima de 16,7 ms em 60fps ele não acompanha, e
           * isso é quase sempre encode em software.
           */
          const encTempo = Number(stat['totalEncodeTime'] ?? 0);
          if (encTempo > 0 && quadros > 0) {
            encodeSegundos += encTempo;
            encodeQuadros += quadros;
          }

          /* ── só no espectador ── */
          if (this.direction === 'inbound') {
            temRecepcao = true;
            jbAtraso += Number(stat['jitterBufferDelay'] ?? 0);
            jbEmitidos += Number(stat['jitterBufferEmittedCount'] ?? 0);
            procAtraso += Number(stat['totalProcessingDelay'] ?? 0);
            procQuadros += Number(stat['framesDecoded'] ?? 0);
            decodeSegundos += Number(stat['totalDecodeTime'] ?? 0);
            congelamentos += Number(stat['freezeCount'] ?? 0);
            tempoCongeladoS += Number(stat['totalFreezesDuration'] ?? 0);
            quadrosDescartados += Number(stat['framesDropped'] ?? 0);
            pacotesPerdidos += Number(stat['packetsLost'] ?? 0);
            pedidosDeKeyframe += Number(stat['pliCount'] ?? 0);
            const dec = stat['decoderImplementation'];
            if (typeof dec === 'string' && dec.length > 0) decoder = dec;
          }

          const impl =
            this.direction === 'outbound'
              ? stat['encoderImplementation']
              : stat['decoderImplementation'];
          if (typeof impl === 'string' && impl.length > 0) encoderImplementation = impl;
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
          if (banda > 0) {
            // Crua, por peer: quem suaviza é o governador, e ele precisa
            // suavizar CADA caminho antes de tirar o mínimo.
            availablePorPeer[peerId] = Math.max(availablePorPeer[peerId] ?? 0, banda);
            available = (available ?? 0) + banda;
            // O pior caminho é quem manda: pela R5 todos recebem o mesmo
            // `maxBitrate`, então a média deixaria o peer fraco afogado.
            pior = pior === null ? banda : Math.min(pior, banda);
            paresMedidos += 1;
          }
        }
      });
    });

    if (!found) return null;

    let bitrateBps = 0;
    let fluxosContados = 0;
    for (const [id, reading] of current) {
      const before = this.previous.get(id);
      if (before === undefined) continue; // fonte nova: sem delta, sem pico
      fluxosContados += 1;
      const deltaBytes = reading.bytes - before.bytes;
      const deltaSeconds = (reading.timestamp - before.timestamp) / 1000;
      if (deltaBytes > 0 && deltaSeconds > 0) {
        bitrateBps += Math.round((deltaBytes * 8) / deltaSeconds);
      }
    }

    // Substitui o mapa inteiro: fonte que sumiu não deixa resíduo.
    this.previous.clear();
    for (const [id, reading] of current) this.previous.set(id, reading);

    /**
     * Bits por pixel POR ESPECTADOR, não do total.
     *
     * `bitrateBps` é a soma sobre os peers, porque é isso que o link de casa
     * precisa aguentar. Mas o encoder é UM só (R5), e cada espectador recebe
     * uma cópia inteira — dividir pelo número de fluxos é o que devolve o
     * número que o encoder de fato viu. Sem a divisão, cinco espectadores
     * fariam 0,02 bpp parecer 0,10 e o diagnóstico mentiria na direção
     * confortável.
     */
    /*
      Divide pelos fluxos que ENTRARAM na soma, não por `current.size`.

      Fonte nova não tem leitura anterior e contribui zero — contá-la no
      divisor fazia o bpp cair pela metade por um segundo quando um espectador
      entrava, acendendo o alerta vermelho por uma ENTRADA, não por queda de
      qualidade.

      E o fps entra sem arredondar: com `Math.round`, uma saída abaixo de meio
      quadro por segundo virava `0`, `bitsPorPixel` devolvia `0`, e a UI lia
      isso como "sem medida" e DESLIGAVA o alarme — no exato momento em que o
      encoder estava saturado e o alarme era mais necessário.
    */
    const fluxos = Math.max(1, fluxosContados);
    const bpp = bitsPorPixel(bitrateBps / fluxos, width, height, fps);

    const recepcao: RecepcaoStats = {
      // `jitterBufferDelay` vem em segundos ACUMULADOS; dividir pela contagem
      // de quadros emitidos dá o atraso médio por quadro, que é o número que
      // se compara com os 80ms que escolhemos como piso.
      jitterBufferMs: jbEmitidos > 0 ? (jbAtraso / jbEmitidos) * 1000 : null,
      processamentoMs: procQuadros > 0 ? (procAtraso / procQuadros) * 1000 : null,
      decodeMs: procQuadros > 0 ? (decodeSegundos / procQuadros) * 1000 : null,
      congelamentos,
      tempoCongeladoS,
      quadrosDescartados,
      pacotesPerdidos,
      pedidosDeKeyframe,
      decoder,
    };

    return {
      fps: Math.round(fps),
      bitrateBps,
      rttMs,
      limitation,
      width,
      height,
      availableBps: available,
      piorAvailableBps: pior,
      paresMedidos,
      availablePorPeer,
      bpp,
      encoderImplementation,
      qp: qpQuadros > 0 ? qpSoma / qpQuadros : null,
      msPorQuadro: encodeQuadros > 0 ? (encodeSegundos / encodeQuadros) * 1000 : null,
      recepcao: temRecepcao ? recepcao : null,
    };
  }
}
