import { type EncodingPreset, type Prioridade, bitsPorPixel } from '@tela/shared';
import { alvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import type { MediaStats, MediaTransport } from '../core/ports/media-transport.js';
import type { AvisoDoWorker } from './injecao-worker.js';
import { type MeshTransportDeps, makeMeshTransport } from './mesh-transport.js';
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
};

/**
 * A isca: um canvas 160x90 ESTÁTICO, que emite um quadro por quadro capturado.
 *
 * A primeira versão era um clone da captura, encolhido — mesmo relógio, de
 * graça. Medido: ~3 quadros-chave por segundo na isca, sem PLI nenhum. A isca
 * carregava o movimento do jogo e a detecção de troca de cena do encoder
 * inseria IDR, que o worker lia como pedido do espectador e virava IDR no
 * codificador único — 112 IDRs em 60 s e o espectador a 20 fps.
 *
 * Estática, ela não tem cena para trocar. Um pixel alterna a cada quadro só
 * para o navegador não tratar o quadro como repetido; `requestFrame` a cada
 * quadro capturado mantém uma vaga por quadro real.
 */
function criarIsca(): { readonly trilha: MediaStreamTrack; readonly tique: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) throw new Error('canvas 2D indisponível para a isca');
  ctx.fillStyle = '#101010';
  ctx.fillRect(0, 0, 160, 90);
  const trilha = canvas.captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (trilha === undefined) throw new Error('isca sem trilha');
  trilha.contentHint = 'motion';
  let par = false;
  return {
    trilha,
    tique: () => {
      par = !par;
      ctx.fillStyle = par ? '#101010' : '#111111';
      ctx.fillRect(0, 0, 1, 1);
      trilha.requestFrame();
    },
  };
}

export function makeEncodeOnceTransport(deps: EncodeOnceDeps): MediaTransport {
  const worker = deps.criarWorker();
  const canal = new MessageChannel();
  worker.postMessage({ tipo: 'porta', porta: canal.port2 }, [canal.port2]);

  const isca = criarIsca();
  const codificador = new CodificadorWebCodecs(
    (chunk, transferir) => canal.port1.postMessage(chunk, transferir),
    () => performance.now(),
    isca.tique,
  );
  canal.port1.onmessage = (m: MessageEvent<AvisoDoWorker>) => {
    if (m.data.tipo === 'chave') codificador.pedirChave(m.data.motivo);
    else codificador.definirAtraso(m.data.quadros);
  };

  /** Todo sender de vídeo que nascer ganha o transform — o mesh não sabe. */
  const anexar = (sender: RTCRtpSender | undefined): void => {
    if (sender === undefined || sender.transform !== null) return;
    sender.transform = new RTCRtpScriptTransform(worker, { id: crypto.randomUUID() });
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

  const mesh = makeMeshTransport({ ...deps, createConnection });

  let preset: EncodingPreset | null = null;
  let orcamento: number | null = null;
  let prioridade: Prioridade = 'fluidez';
  let piorEstimativa: number | null = null;
  let fonte: { width: number; height: number } | null = null;
  let iniciado = false;
  let limitadoPelaEstimativa = false;

  const alvo = () => {
    if (preset === null) return null;
    const a = alvoDoCodificador({ preset, orcamento, prioridade, fonte, piorEstimativa });
    limitadoPelaEstimativa = a.limitadoPelaEstimativa;
    return a;
  };
  const recalcular = (): void => {
    const a = alvo();
    if (a !== null && iniciado) codificador.configurar(a);
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
      codificador.trocarFonte(track);
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
      recalcular();
      const c = codificador.estatisticas();
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
        encoderImplementation: c.hardware === null ? 'WebCodecs' : c.hardware ? 'WebCodecs·hardware' : 'WebCodecs·software',
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
      codificador.parar();
      isca.trilha.stop();
      worker.terminate();
      await mesh.disconnect();
    },
  };
}
