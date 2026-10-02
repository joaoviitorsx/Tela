import type { IceServerConfig } from '@tela/shared';
import { RelogioDeCaptura, type ReferenciaDeCaptura } from '../core/media/relogio-de-captura.js';
import { PeerLink } from '../core/mesh/peer-link.js';
import type { RelatorioDoRepassador } from '../core/mesh/protocolo-de-repasse.js';
import type { AvisoDoWorker, MensagemAoWorker } from './injecao-worker.js';
import { type Isca, criarIsca } from './isca.js';

/**
 * O espectador que repassa o vídeo a outros (ADR 0031, fase 1).
 *
 * O quadro que chega do anfitrião é COPIADO no transform de recepção, entra
 * numa `FilaDeInjecao` e sai nos senders dos filhos trocando o conteúdo de
 * uma isca — o mesmo "um encode, N envios" do anfitrião (D0b), com a recepção
 * no lugar do codificador. Nada é recodificado: o filho decodifica os mesmos
 * bytes que o anfitrião produziu.
 *
 * Só o vídeo passa por aqui. O áudio do filho continua vindo direto do
 * anfitrião (141 kbps por pessoa não pesam a ninguém) — não há isca de áudio.
 *
 * # O transform de recepção nasce com a ligação
 *
 * Medido em Chromium 151: um `receiver.transform` atribuído com a mídia já
 * fluindo não recebe quadro nenhum, e trocá-lo ou tirá-lo depois não é seguro.
 * Por isso quem PODE repassar liga o transform no `ontrack` (antes do primeiro
 * pacote), em modo de passagem: sem filho, o worker só devolve cada quadro ao
 * decoder, sem cópia e sem relógio. Isca, arestas e relatório nascem no
 * primeiro filho e morrem no último; o worker vive a sessão inteira.
 */
export type DepsDoRepassador = {
  readonly criarWorker: () => Worker;
  readonly createConnection: (config: RTCConfiguration) => RTCPeerConnection;
  readonly iceServers: () => readonly IceServerConfig[];
  /** Sinal para o filho, pelo anfitrião (`via`). */
  readonly enviarVia: (para: string, dados: unknown) => void;
  readonly enviarRelatorio: (relatorio: RelatorioDoRepassador) => void;
  /** O `getStats` da ligação com o anfitrião, para saber se este nó aguenta. */
  readonly statsDaRecepcao: () => Promise<RTCStatsReport | null>;
  /** A referência de captura da ligação com o anfitrião: o atraso até aqui. */
  readonly referenciaDoAnfitriao: () => Promise<ReferenciaDeCaptura | null>;
};

/**
 * O que o repassador conta a cada filho pelo `via`: quanto o quadro já tinha
 * de atraso quando chegou aqui. O `abs-capture-time` não atravessa o salto
 * (o carimbo que o filho lê é o da isca), então o filho soma este número ao
 * que mede da aresta e o HUD mostra a latência de ponta a ponta.
 */
export type AtrasoDoPai = { readonly atrasoDoPaiMs: number };

/** Teto do `maxBitrate` das arestas para os filhos: o teto útil do 1080p60. */
const TETO_DA_ARESTA_BPS = 25_000_000;
/** Estimativa inicial das arestas: perto do que a sala costuma usar. */
const INICIO_DA_ARESTA_BPS = 2_500_000;
/**
 * Quadros descartados acima desta fração (entre um relatório e outro) dizem que
 * o próprio repassador não dá conta: deve largar filho. Fração e não fps: a
 * fonte pode ser 30 (nitidez) ou estar parada (tela estática).
 */
const DESCARTE_MAXIMO = 0.05;
const RELATORIO_A_CADA_MS = 2_000;

/** Navegador com o que o repasse precisa: Encoded Transform no receiver e no sender. */
export function suportaRepasse(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof (window as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform !== 'function') return false;
  if (typeof RTCRtpReceiver === 'undefined' || !('transform' in RTCRtpReceiver.prototype)) return false;
  // Celular não repassa: bateria e plano de dados de outra pessoa.
  const dados = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (dados?.mobile === true) return false;
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return false;
  return true;
}

type Filho = { readonly link: PeerLink; readonly idDoTransform: string };

export class Repassador {
  private readonly filhos = new Map<string, Filho>();
  private worker: Worker | null = null;
  private isca: Isca | null = null;
  private stream: MediaStream | null = null;
  private relatorio: ReturnType<typeof setInterval> | null = null;
  private contadores: Contadores | null = null;
  private readonly relogio = new RelogioDeCaptura();

  constructor(private readonly deps: DepsDoRepassador) {}

  get quantos(): number {
    return this.filhos.size;
  }

  /**
   * Liga o transform de recepção — no `ontrack`, antes do primeiro pacote.
   * Uma ligação refeita com o anfitrião chama de novo com o receiver novo.
   */
  prepararRecepcao(receptor: RTCRtpReceiver): void {
    const worker = this.garantirWorker();
    receptor.transform = new RTCRtpScriptTransform(worker, { papel: 'recepcao' });
  }

  adicionar(filho: string): void {
    if (this.filhos.has(filho) || this.worker === null) return;
    const worker = this.worker;
    const { isca, stream } = this.ligarIsca();
    const idDoTransform = crypto.randomUUID();
    const link = new PeerLink({
      peerId: filho,
      // Quem tem a mídia oferta e não recua — como o anfitrião na malha.
      polite: false,
      iceServers: this.deps.iceServers(),
      send: (payload) => this.deps.enviarVia(filho, payload),
      createConnection: this.deps.createConnection,
      startBitrateBps: () => INICIO_DA_ARESTA_BPS,
      onIssue: (code) => console.warn('[repasse]', code),
    });
    const sender = link.addTrack(isca.trilha, stream);
    sender.transform = new RTCRtpScriptTransform(worker, { id: idDoTransform });
    this.filhos.set(filho, { link, idDoTransform });
    void this.configurarAresta(sender);
  }

  remover(filho: string): void {
    const f = this.filhos.get(filho);
    if (f === undefined) return;
    this.filhos.delete(filho);
    f.link.close();
    this.worker?.postMessage({ tipo: 'pausa', id: f.idDoTransform } satisfies MensagemAoWorker);
    if (this.filhos.size === 0) this.desligarIsca();
  }

  sinal(de: string, dados: unknown): void {
    void this.filhos.get(de)?.link.handleSignal(dados).catch(() => this.remover(de));
  }

  fechar(): void {
    for (const id of [...this.filhos.keys()]) this.remover(id);
    this.desligarIsca();
    this.worker?.terminate();
    this.worker = null;
  }

  private garantirWorker(): Worker {
    if (this.worker !== null) return this.worker;
    const worker = this.deps.criarWorker();
    const canal = new MessageChannel();
    worker.postMessage({ tipo: 'porta', porta: canal.port2, papel: 'repassador' } satisfies MensagemAoWorker, [canal.port2]);
    canal.port1.onmessage = (m: MessageEvent<AvisoDoWorker>) => {
      if (m.data.tipo === 'tique') this.isca?.tique();
    };
    this.worker = worker;
    return worker;
  }

  /** Isca e relatório: nascem no primeiro filho. */
  private ligarIsca(): { isca: Isca; stream: MediaStream } {
    if (this.isca !== null && this.stream !== null) return { isca: this.isca, stream: this.stream };
    const isca = criarIsca();
    this.isca = isca;
    this.stream = new MediaStream([isca.trilha]);
    this.contadores = null;
    this.relatorio = setInterval(() => void this.relatar(), RELATORIO_A_CADA_MS);
    return { isca, stream: this.stream };
  }

  private desligarIsca(): void {
    if (this.relatorio !== null) clearInterval(this.relatorio);
    this.relatorio = null;
    this.isca?.trilha.stop();
    this.isca = null;
    this.stream = null;
  }

  /**
   * A isca vai com teto ALTO: a estimativa de banda da aresta não passa do
   * `maxBitrate` gravado (ADR 0018), e um teto de isca a cegaria. A
   * preferência é manter quadro — R5, e o quadro nem é desta isca.
   */
  private async configurarAresta(sender: RTCRtpSender): Promise<void> {
    for (let tentativa = 0; tentativa < 30; tentativa += 1) {
      const params = sender.getParameters();
      const [primeiro, ...resto] = params.encodings ?? [];
      if (primeiro !== undefined) {
        try {
          await sender.setParameters({
            ...params,
            encodings: [{ ...primeiro, maxBitrate: TETO_DA_ARESTA_BPS }, ...resto],
            degradationPreference: 'maintain-framerate',
          });
        } catch {
          // Navegador que recusa: a aresta fica com o teto padrão.
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  private async relatar(): Promise<void> {
    if (this.filhos.size === 0) return;
    let pior: number | null = null;
    for (const { link } of this.filhos.values()) {
      const saida = await disponivelDeSaida(link).catch(() => null);
      if (saida !== null) pior = pior === null ? saida : Math.min(pior, saida);
    }
    const recepcao = await this.deps.statsDaRecepcao().catch(() => null);
    const agora = recepcao === null ? null : contadoresDeVideo(recepcao);
    const antes = this.contadores;
    this.contadores = agora;
    let sobrecarregado = false;
    if (agora !== null && antes !== null) {
      const decodificados = agora.decodificados - antes.decodificados;
      const descartados = agora.descartados - antes.descartados;
      sobrecarregado =
        agora.congelamentos > antes.congelamentos ||
        descartados > DESCARTE_MAXIMO * Math.max(1, decodificados + descartados);
    }
    this.deps.enviarRelatorio({ repasse: 'relatorio', filhos: this.filhos.size, piorSaidaBps: pior, sobrecarregado });

    const atraso = await this.atrasoAteAqui();
    if (atraso !== null) {
      for (const id of this.filhos.keys()) this.deps.enviarVia(id, { atrasoDoPaiMs: atraso } satisfies AtrasoDoPai);
    }
  }

  /** Captura no anfitrião → quadro entregue aqui, em ms; `null` sem medida. */
  private async atrasoAteAqui(): Promise<number | null> {
    const ref = await this.deps.referenciaDoAnfitriao().catch(() => null);
    if (ref?.entregueMs === undefined) return null;
    const agora = Date.now();
    this.relogio.observar(ref, agora);
    const ms = this.relogio.latenciaMs(ref.rtpTimestamp, ref.entregueMs, agora);
    return ms === null ? null : Math.round(ms);
  }
}

async function disponivelDeSaida(link: PeerLink): Promise<number | null> {
  const report = await link.stats();
  let valor: number | null = null;
  report.forEach((s: { type?: string; nominated?: boolean; state?: string; availableOutgoingBitrate?: number }) => {
    if (s.type !== 'candidate-pair' || s.nominated !== true || s.state !== 'succeeded') return;
    if (typeof s.availableOutgoingBitrate === 'number') valor = s.availableOutgoingBitrate;
  });
  return valor;
}

type Contadores = { readonly decodificados: number; readonly descartados: number; readonly congelamentos: number };

function contadoresDeVideo(report: RTCStatsReport): Contadores | null {
  let c: Contadores | null = null;
  report.forEach(
    (s: { type?: string; kind?: string; framesDecoded?: number; framesDropped?: number; freezeCount?: number }) => {
      if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
      c = { decodificados: s.framesDecoded ?? 0, descartados: s.framesDropped ?? 0, congelamentos: s.freezeCount ?? 0 };
    },
  );
  return c;
}
