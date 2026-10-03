import { type PerfilH264, perfilDaSala } from '../core/media/perfil-h264.js';
import { type EncodingPreset, type Prioridade, bitsPorPixel } from '@tela/shared';
import { alvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import type { MediaStats, MediaTransport } from '../core/ports/media-transport.js';
import type { CodificadorUnico, DepsDoCodificador } from './codificador-unico.js';
import type { AvisoDoWorker, MensagemAoWorker } from './injecao-worker.js';
import { type MeshTransportDeps, makeMeshTransport } from './mesh-transport.js';
import { criarIsca } from './isca.js';
import { CodificadorWebCodecs } from './webcodecs-codificador.js';

/**
 * `MediaTransport` com "um encode, N envios" (D0b,
 * `docs/desktop/D0b-um-encode-n-envios.md`).
 *
 * O Chromium codifica uma vez POR `RTCPeerConnection`: com três amigos, o vídeo
 * é codificado três vezes (medido no D0). Este transporte embrulha o mesh de
 * sempre e muda só isso:
 *
 * - os senders recebem uma ISCA de 160x90 com parâmetros fixos — custo de
 *   codificação desprezível, e nenhuma reconfiguração que gere quadro-chave;
 * - um codificador único (WebCodecs) codifica a captura real;
 * - um Encoded Transform troca o conteúdo de cada quadro-isca pelo quadro real.
 *
 * A `BroadcastSession` e as malhas não sabem de nada: o degrau, o orçamento e a
 * prioridade que elas mandam passam a mirar o codificador único, e as
 * estatísticas devolvem os bytes REAIS dos senders com o tamanho e o fps do
 * codificador. Sinalização, protocolo e espectador não mudam.
 */
export type EncodeOnceDeps = MeshTransportDeps & {
  /** O worker de injeção. Fábrica: o Vite precisa ver o `new Worker(new URL(...))`. */
  readonly criarWorker: () => Worker;
  /** Quem codifica. Padrão: WebCodecs sobre a trilha capturada. */
  readonly criarCodificador?: (deps: DepsDoCodificador) => CodificadorUnico;
  /** Liga a cascata de repasse sem esperar a malha apertar — só e2e (ADR 0031). */
  readonly forcarRepasse?: boolean;
};

/**
 * Com filho de repassador na sala, um IDR a cada este tanto (ADR 0031, E2).
 *
 * O filho que entra no repassador espera um IDR; pedir um ao anfitrião a cada
 * entrada (o PLI subindo) deixava o repassador e todos os filhos 1,5–2 s sem
 * quadro a partir do 3º filho. Com IDR periódico ninguém pede: a entrada leva
 * no máximo isto, e o custo (~4–8 % de bits) só existe enquanto há repasse.
 */
export const IDR_DO_REPASSE_MS = 2_000;

export function makeEncodeOnceTransport(deps: EncodeOnceDeps): MediaTransport {
  /*
    Worker, isca e codificador nascem no primeiro uso, não aqui. A sessão que
    embrulha este transporte é criada no render da rota; uma sessão que o React
    descarta (render recomeçado, StrictMode) não pode deixar um worker, uma
    trilha de canvas e um encoder para trás — eram ~2 MB de worker cada, e
    passaram de cem num só ir ao ar no app (ver container.desktop.ts).
  */
  type Recursos = {
    readonly worker: Worker;
    readonly isca: ReturnType<typeof criarIsca>;
    readonly codificador: CodificadorUnico;
  };
  let recursos: Recursos | null = null;
  /** Espectadores soltos da contrapressão desde a última leitura de estatísticas. */
  let soltosDesdeALeitura = 0;
  let ultimaLeitura = performance.now();
  const garantir = (): Recursos => {
    if (recursos !== null) return recursos;
    const worker = deps.criarWorker();
    const canal = new MessageChannel();
    worker.postMessage({ tipo: 'porta', porta: canal.port2 }, [canal.port2]);
    const isca = criarIsca();
    const criarCodificador =
      deps.criarCodificador ?? ((d: DepsDoCodificador) => new CodificadorWebCodecs(d.entregar, () => performance.now(), d.aoCapturar));
    const codificador = criarCodificador({
      entregar: (chunk, transferir) => canal.port1.postMessage(chunk, transferir),
      aoCapturar: isca.tique,
      aoMudarFonte: () => recalcular(),
    });
    canal.port1.onmessage = (m: MessageEvent<AvisoDoWorker>) => {
      if (m.data.tipo === 'chave') codificador.pedirChave(m.data.motivo, m.data.senders);
      else if (m.data.tipo === 'atraso') {
        codificador.definirAtraso(m.data.quadros);
        // O relógio do worker (~10 Hz) não para com a aba escondida.
        codificador.manterVivo?.();
      }
      else if (m.data.tipo === 'arrasto') soltosDesdeALeitura += m.data.soltos;
    };
    recursos = { worker, isca, codificador };
    return recursos;
  };

  /** O id de cada transform: a pausa da cascata tira aquele sender da fila. */
  const idDoSender = new WeakMap<RTCRtpSender, string>();
  /**
   * Os senders de vídeo vivos, para o piso de perfil da sala. Quem fechou sai
   * na leitura seguinte (o `close()` da conexão não dispara evento).
   */
  const sendersDeVideo = new Set<RTCRtpSender>();
  let cascataAtiva = false;
  let perfil: PerfilH264 = 'baseline';
  /** Relê o perfil que a sala aceita. `true` = mudou (o codificador vai reconfigurar, com IDR). */
  const atualizarPerfil = (): boolean => {
    const fmtps: (string | undefined)[] = [];
    for (const sender of sendersDeVideo) {
      const estado = sender.transport?.state;
      if (estado === 'closed' || estado === 'failed') {
        sendersDeVideo.delete(sender);
        continue;
      }
      if (estado !== 'connected') continue;
      fmtps.push(sender.getParameters().codecs?.[0]?.sdpFmtpLine);
    }
    const daSala = perfilDaSala(fmtps, cascataAtiva);
    if (daSala === null || daSala === perfil) return false;
    perfil = daSala;
    return true;
  };
  /** Todo sender de vídeo que nascer ganha o transform — o mesh não sabe. */
  const anexar = (sender: RTCRtpSender | undefined): void => {
    if (sender === undefined || sender.transform !== null) return;
    const id = crypto.randomUUID();
    idDoSender.set(sender, id);
    sendersDeVideo.add(sender);
    sender.transform = new RTCRtpScriptTransform(garantir().worker, { id });
  };

  let idrPeriodico: ReturnType<typeof setInterval> | null = null;
  const repasse = {
    ...deps.repasse,
    anfitriao: {
      aoPausarSender: (sender: RTCRtpSender, pausado: boolean) => {
        const id = idDoSender.get(sender);
        if (id === undefined) return;
        if (pausado) {
          recursos?.worker.postMessage({ tipo: 'pausa', id } satisfies MensagemAoWorker);
          return;
        }
        // Voltou porque o repassador falhou: o filho está com a imagem parada.
        // A primeira vaga recoloca o sender na fila, e o IDR sai já, com a
        // janela de entrada — sem esperar a janela da plateia nem o periódico.
        recursos?.codificador.pedirChave('entrada', 1);
      },
      aoMudarAtividade: (ativa: boolean) => {
        // Cascata: o anfitrião não vê o que os filhos negociaram — a sala desce a Baseline.
        cascataAtiva = ativa;
        if (atualizarPerfil()) recalcular();
        if (idrPeriodico !== null) clearInterval(idrPeriodico);
        idrPeriodico = ativa ? setInterval(() => recursos?.codificador.pedirChave('repasse', 1), IDR_DO_REPASSE_MS) : null;
      },
      ...(deps.forcarRepasse === true ? { forcar: true } : {}),
    },
  };
  const base = deps.createConnection ?? ((c: RTCConfiguration) => new RTCPeerConnection(c));
  const createConnection = (config: RTCConfiguration): RTCPeerConnection => {
    const pc = base(config);
    const addTrack = pc.addTrack.bind(pc);
    pc.addTrack = (track: MediaStreamTrack, ...streams: MediaStream[]) => {
      const sender = addTrack(track, ...streams);
      if (track.kind === 'video') anexar(sender);
      return sender;
    };
    const addTransceiver = pc.addTransceiver.bind(pc);
    pc.addTransceiver = (alvo: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) => {
      const tr = addTransceiver(alvo, init);
      const tipo = typeof alvo === 'string' ? alvo : alvo.kind;
      if (tipo === 'video') anexar(tr.sender);
      return tr;
    };
    return pc;
  };

  const mesh = makeMeshTransport({ ...deps, createConnection, repasse });

  let preset: EncodingPreset | null = null;
  let orcamento: number | null = null;
  let prioridade: Prioridade = 'fluidez';
  let piorEstimativa: number | null = null;
  let fonte: { width: number; height: number } | null = null;
  let iniciado = false;
  let limitadoPelaEstimativa = false;

  const alvo = () => {
    if (preset === null) return null;
    const a = alvoDoCodificador({
      preset,
      orcamento,
      prioridade,
      fonte: recursos?.codificador.fonte() ?? fonte,
      piorEstimativa,
      perfil,
    });
    limitadoPelaEstimativa = a.limitadoPelaEstimativa;
    return a;
  };
  const recalcular = (): void => {
    const a = alvo();
    if (a !== null && iniciado) recursos?.codificador.configurar(a);
  };
  const medirFonte = (track: MediaStreamTrack): void => {
    const s = track.getSettings();
    fonte = s.width !== undefined && s.height !== undefined ? { width: s.width, height: s.height } : null;
  };

  return {
    ...mesh,

    async publishVideo(track, next) {
      preset = next;
      medirFonte(track);
      /*
        A isca vai com o degrau REAL: a topologia calcula `maxBitrate` pelo teto
        útil do degrau (24,9 Mbps em 1080p60). Um teto de isca (centenas de
        kbps) cegaria o estimador de banda — o defeito da ADR 0018.
      */
      const { isca, codificador } = garantir();
      await mesh.publishVideo(isca.trilha, next);
      const a = alvo();
      if (a !== null) {
        await codificador.iniciar(track, a);
        iniciado = true;
      }
    },

    async replaceVideo(track) {
      // A isca continua a mesma: só a captura do codificador troca.
      medirFonte(track);
      recursos?.codificador.trocarFonte(track);
      recalcular();
    },

    // Degrau, orçamento e prioridade miram o codificador; a isca nunca é
    // reconfigurada — reconfigurar gera quadro-chave nela, que viraria IDR.
    async setPreset(next) {
      preset = next;
      recalcular();
    },
    async setUplinkBudget(bps) {
      orcamento = bps;
      recalcular();
    },
    async setPrioridade(p) {
      prioridade = p;
      recalcular();
    },

    async getAggregateStats(): Promise<MediaStats | null> {
      const s = await mesh.getAggregateStats();
      if (s === null || !iniciado) return s;
      // Freio rápido: a estimativa medida agora entra no alvo do codificador.
      piorEstimativa = s.piorAvailableBps;
      // E o piso de perfil da sala, relido no mesmo tique (O(N), N ≤ 50).
      atualizarPerfil();
      recalcular();
      if (recursos === null) return s;
      const c = recursos.codificador.estatisticas();
      const agora = performance.now();
      const segundos = Math.max(0.001, (agora - ultimaLeitura) / 1000);
      ultimaLeitura = agora;
      const fila = { seguradosPorSegundo: c.segurados / segundos, soltos: soltosDesdeALeitura };
      soltosDesdeALeitura = 0;
      const porPar = s.bitrateBps / Math.max(1, s.paresMedidos);
      return {
        ...s,
        width: c.width,
        height: c.height,
        fps: c.fps,
        bpp: c.width > 0 && c.fps > 0 ? bitsPorPixel(porPar, c.width, c.height, c.fps) : 0,
        // O WebCodecs não expõe QP; o tempo por quadro é a leitura de carga.
        qp: null,
        msPorQuadro: c.msPorQuadro,
        encoderImplementation: c.implementacao,
        fila,
        ...(c.fpsDaCaptura === undefined ? {} : { fpsDaCaptura: c.fpsDaCaptura }),
        /*
          Os motivos que as malhas leem, com a mesma semântica do Chromium:
          `cpu` quando o encoder não dá conta, `bandwidth` quando a estimativa
          está segurando o bitrate abaixo do orçamento — é esse sinal que faz a
          malha descer o DEGRAU em vez de deixar 1080p com bits de menos.
        */
        limitation: c.sobrecarregado ? 'cpu' : limitadoPelaEstimativa ? 'bandwidth' : 'none',
      };
    },

    async disconnect() {
      if (idrPeriodico !== null) clearInterval(idrPeriodico);
      idrPeriodico = null;
      sendersDeVideo.clear();
      recursos?.codificador.parar();
      recursos?.isca.trilha.stop();
      recursos?.worker.terminate();
      recursos = null;
      await mesh.disconnect();
    },
  };
}
