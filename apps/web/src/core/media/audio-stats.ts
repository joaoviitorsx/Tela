import type { RelatorioDePeer, ResumoConfigAudio } from '../mesh/mesh-topology.js';

/**
 * O áudio no `getStats()`, separado do vídeo (TELA-007, §6.9 do plano).
 *
 * # Por que isto existe
 *
 * `StatsSampler` só lia `kind === 'video'`. O áudio saía e chegava sem um
 * único número: "som metálico", "picota" e "sumiu" chegavam como relato e
 * saíam como palpite, e nenhum deles distinguia problema de ORIGEM, de REDE e
 * de REPRODUÇÃO — que é o critério central da §6.10.
 *
 * # As três regras, e por que são regras
 *
 * 1. **Taxa por intervalo, nunca acumulado.** Todo contador de `inbound-rtp`
 *    é soma desde o início do fluxo. Dividir acumulado por acumulado dá a
 *    média da sessão, e dez minutos limpos diluem um episódio de perda até
 *    ele sumir — o mesmo erro que `ParAcumulado` já corrigiu no vídeo.
 *
 * 2. **Delta só entre leituras comparáveis.** A chave é peer + SSRC: fluxo
 *    novo não tem leitura anterior e não produz número no primeiro ciclo.
 *    Contador que anda para trás é fluxo reiniciado, e o delta vira `null`,
 *    não um número negativo nem zero.
 *
 * 3. **Ausente é desconhecido.** Campo que o navegador não reporta vira
 *    `null`. Zero é uma medida — "zero de perda" é uma afirmação, e o produto
 *    não pode fazê-la sobre um campo que não leu.
 *
 * Não soma contadores de peers como se fossem um fluxo contínuo: soma TAXAS,
 * cada uma calculada no próprio fluxo.
 */

/** Parâmetros Opus que interessam à política de áudio (§6.5). Nada mais do SDP entra. */
const PARAMETROS_OPUS = [
  'stereo',
  'sprop-stereo',
  'useinbandfec',
  'usedtx',
  'maxaveragebitrate',
  'maxplaybackrate',
  'minptime',
  'cbr',
] as const;

export type ParametroOpus = (typeof PARAMETROS_OPUS)[number];

export type CodecDeAudio = {
  /** `audio/opus`, por exemplo. `null` quando o relatório não traz o codec. */
  readonly mimeType: string | null;
  readonly canais: number | null;
  readonly clockRate: number | null;
  /**
   * O `a=fmtp` negociado, filtrado por lista fechada de chaves e valores
   * numéricos. É a única forma de saber se `stereo=1` chegou ao transporte
   * sem copiar SDP para o diagnóstico.
   */
  readonly parametros: Readonly<Partial<Record<ParametroOpus, number>>>;
};

export type AudioStats = {
  /** Quantos fluxos RTP de áudio o relatório trouxe. Um por espectador no transmissor. */
  readonly fluxos: number;
  /** Soma das taxas dos fluxos com delta válido. `null` no primeiro ciclo. */
  readonly bitrateBps: number | null;
  /**
   * Energia RMS do intervalo, 0 a 1 — `sqrt(Δ totalAudioEnergy / Δ totalSamplesDuration)`.
   *
   * No transmissor vem de `media-source`: é o que ENTRA no encoder, depois do
   * ganho. No espectador vem de `inbound-rtp`: é o que saiu do decoder, antes
   * do volume local. Os dois lados juntos localizam onde o som some.
   */
  readonly nivel: number | null;
  /** Só no espectador: pacotes perdidos / esperados no intervalo, 0 a 1. */
  readonly perda: number | null;
  /** Só no espectador: jitter de chegada reportado pelo navegador, em ms. */
  readonly jitterMs: number | null;
  /** Só no espectador: atraso médio do jitter buffer de ÁUDIO no intervalo, em ms. */
  readonly jitterBufferMs: number | null;
  /**
   * Só no espectador: `Δ concealedSamples / Δ totalSamplesReceived`.
   *
   * Sinal de degradação, não nota perceptiva: é a fração do som que o
   * decoder INVENTOU para tapar buraco. Só existe com denominador positivo.
   */
  readonly ocultacao: number | null;
  /** Só no espectador: quantas vezes o decoder começou a inventar som no intervalo. */
  readonly eventosOcultacao: number | null;
  readonly codec: CodecDeAudio | null;
  /**
   * Só no transmissor: o que os senders ACEITARAM (TELA-008). O amostrador
   * não sabe disso — quem preenche é o transporte, que tem a topologia.
   */
  readonly configuracao: ResumoConfigAudio | null;
};

type Leitura = {
  readonly t: number;
  readonly bytes: number | null;
  readonly recebidos: number | null;
  readonly perdidos: number | null;
  readonly amostras: number | null;
  readonly ocultadas: number | null;
  readonly eventos: number | null;
  readonly jbAtraso: number | null;
  readonly jbEmitidos: number | null;
  readonly energia: number | null;
  readonly duracao: number | null;
};

function numero(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/** Delta entre duas leituras do mesmo contador; `null` se faltar ou se o contador voltou. */
function delta(agora: number | null, antes: number | null | undefined): number | null {
  if (agora === null || antes === null || antes === undefined) return null;
  const d = agora - antes;
  return d < 0 ? null : d;
}

function parametrosOpus(linha: unknown): CodecDeAudio['parametros'] {
  if (typeof linha !== 'string') return {};
  const conhecidos: ReadonlySet<string> = new Set(PARAMETROS_OPUS);
  const saida: Partial<Record<ParametroOpus, number>> = {};
  for (const par of linha.split(';')) {
    const [chave, valor] = par.split('=').map((s) => s.trim());
    if (chave === undefined || valor === undefined || !conhecidos.has(chave)) continue;
    if (!/^\d{1,7}$/.test(valor)) continue;
    saida[chave as ParametroOpus] = Number(valor);
  }
  return saida;
}

function codecDe(report: RTCStatsReport, codecId: unknown): CodecDeAudio | null {
  if (typeof codecId !== 'string') return null;
  let achado: CodecDeAudio | null = null;
  report.forEach((entry) => {
    const stat = entry as Record<string, unknown>;
    if (achado !== null || stat['type'] !== 'codec' || stat['id'] !== codecId) return;
    const mime = stat['mimeType'];
    achado = {
      mimeType: typeof mime === 'string' && /^audio\/[a-zA-Z0-9-]{1,32}$/.test(mime) ? mime : null,
      canais: numero(stat['channels']),
      clockRate: numero(stat['clockRate']),
      parametros: parametrosOpus(stat['sdpFmtpLine']),
    };
  });
  return achado;
}

export class AudioStatsSampler {
  private anteriores = new Map<string, Leitura>();
  /** Última taxa de cada fluxo: a leitura retida do rodízio (B2) não tem tempo decorrido. */
  private taxas = new Map<string, number>();

  constructor(private readonly direcao: 'outbound' | 'inbound') {}

  reset(): void {
    this.anteriores.clear();
    this.taxas.clear();
  }

  /** `null` quando nenhum relatório traz fluxo de áudio: não há áudio nesta sessão. */
  readMany(entradas: readonly RelatorioDePeer[]): AudioStats | null {
    const tipo = this.direcao === 'outbound' ? 'outbound-rtp' : 'inbound-rtp';
    const atuais = new Map<string, Leitura>();
    let fluxos = 0;
    let codec: CodecDeAudio | null = null;
    let jitterMs: number | null = null;

    entradas.forEach(({ peerId, report }) => {
      report.forEach((entry, key) => {
        const stat = entry as Record<string, unknown>;
        if (stat['kind'] !== 'audio') return;
        const t = numero(stat['timestamp']);
        if (t === null) return;

        if (stat['type'] === tipo) {
          fluxos += 1;
          const ssrc = stat['ssrc'];
          const id = typeof ssrc === 'number' ? String(ssrc) : String(stat['id'] ?? key);
          atuais.set(`${peerId}:rtp:${id}`, {
            t,
            bytes: numero(stat[this.direcao === 'outbound' ? 'bytesSent' : 'bytesReceived']),
            recebidos: numero(stat['packetsReceived']),
            perdidos: numero(stat['packetsLost']),
            amostras: numero(stat['totalSamplesReceived']),
            ocultadas: numero(stat['concealedSamples']),
            eventos: numero(stat['concealmentEvents']),
            jbAtraso: numero(stat['jitterBufferDelay']),
            jbEmitidos: numero(stat['jitterBufferEmittedCount']),
            // No envio a energia vem da `media-source`, abaixo.
            energia: this.direcao === 'inbound' ? numero(stat['totalAudioEnergy']) : null,
            duracao: this.direcao === 'inbound' ? numero(stat['totalSamplesDuration']) : null,
          });
          if (codec === null) codec = codecDe(report, stat['codecId']);
          if (this.direcao === 'inbound') {
            const j = numero(stat['jitter']);
            if (j !== null) jitterMs = Math.max(jitterMs ?? 0, j * 1000);
          }
          return;
        }

        // O que entra no encoder. Não tem SSRC: a chave é o id do relatório.
        if (this.direcao === 'outbound' && stat['type'] === 'media-source') {
          atuais.set(`${peerId}:src:${String(stat['id'] ?? key)}`, {
            t,
            bytes: null,
            recebidos: null,
            perdidos: null,
            amostras: null,
            ocultadas: null,
            eventos: null,
            jbAtraso: null,
            jbEmitidos: null,
            energia: numero(stat['totalAudioEnergy']),
            duracao: numero(stat['totalSamplesDuration']),
          });
        }
      });
    });

    const anteriores = this.anteriores;
    // Substitui o mapa inteiro: fluxo que sumiu não deixa resíduo.
    this.anteriores = atuais;
    if (fluxos === 0) return null;

    let bits: number | null = null;
    let recebidos = 0;
    let perdidos = 0;
    let amostras = 0;
    let ocultadas = 0;
    let eventos: number | null = null;
    let jbAtraso = 0;
    let jbEmitidos = 0;
    let energia = 0;
    let duracao = 0;

    const taxas = new Map<string, number>();
    for (const [chave, agora] of atuais) {
      const antes = anteriores.get(chave);
      if (antes === undefined) continue; // fluxo novo: sem delta, sem número

      const segundos = (agora.t - antes.t) / 1000;
      const dBytes = delta(agora.bytes, antes.bytes);
      if (dBytes !== null && segundos > 0) {
        const taxa = (dBytes * 8) / segundos;
        taxas.set(chave, taxa);
        bits = (bits ?? 0) + taxa;
      } else if (segundos === 0 && this.taxas.has(chave)) {
        // Leitura retida (rodízio, B2): vale a última taxa real do fluxo.
        const taxa = this.taxas.get(chave)!;
        taxas.set(chave, taxa);
        bits = (bits ?? 0) + taxa;
      }

      const dRec = delta(agora.recebidos, antes.recebidos);
      const dPerd = delta(agora.perdidos, antes.perdidos);
      if (dRec !== null && dPerd !== null) {
        recebidos += dRec;
        perdidos += dPerd;
      }

      const dAm = delta(agora.amostras, antes.amostras);
      const dOc = delta(agora.ocultadas, antes.ocultadas);
      if (dAm !== null && dOc !== null) {
        amostras += dAm;
        ocultadas += dOc;
      }

      const dEv = delta(agora.eventos, antes.eventos);
      if (dEv !== null) eventos = (eventos ?? 0) + dEv;

      const dJa = delta(agora.jbAtraso, antes.jbAtraso);
      const dJe = delta(agora.jbEmitidos, antes.jbEmitidos);
      if (dJa !== null && dJe !== null) {
        jbAtraso += dJa;
        jbEmitidos += dJe;
      }

      const dEn = delta(agora.energia, antes.energia);
      const dDu = delta(agora.duracao, antes.duracao);
      if (dEn !== null && dDu !== null) {
        energia += dEn;
        duracao += dDu;
      }
    }

    this.taxas = taxas;
    const esperados = recebidos + perdidos;
    return {
      fluxos,
      bitrateBps: bits === null ? null : Math.round(bits),
      nivel: duracao > 0 ? Math.sqrt(energia / duracao) : null,
      perda: esperados > 0 ? perdidos / esperados : null,
      jitterMs,
      jitterBufferMs: jbEmitidos > 0 ? (jbAtraso / jbEmitidos) * 1000 : null,
      ocultacao: amostras > 0 ? ocultadas / amostras : null,
      eventosOcultacao: eventos,
      codec,
      configuracao: null,
    };
  }
}
