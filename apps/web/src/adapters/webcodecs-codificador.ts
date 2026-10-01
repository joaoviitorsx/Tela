import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { janelaDeChaveMs } from '../core/media/fila-de-injecao.js';
import type { CodificadorUnico, EstatisticasDoCodificador } from './codificador-unico.js';
import type { ChunkInjetado } from './injecao-worker.js';

/**
 * O codificador ÚNICO do "um encode, N envios", sobre WebCodecs.
 *
 * Lê os quadros da captura (`MediaStreamTrackProcessor`), codifica H.264 Annex
 * B uma vez e entrega cada quadro codificado a quem injeta nos senders. No
 * Windows o Chromium usa o encoder de hardware quando existe (`no-preference`
 * deixa ele escolher, como no WebRTC); no Linux com NVIDIA cai em software —
 * ver docs/desktop/D0-relatorio-linux.md.
 */

/** Não-padrão (Chromium): o TypeScript não traz. */
declare class MediaStreamTrackProcessor<T> {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<T>;
}

/**
 * H.264 Constrained Baseline nível 4.2: cobre 1080p60, e é o perfil que o
 * WebRTC do Chromium negocia por padrão — o decoder do espectador já espera.
 */
export const CODEC = 'avc1.42e02a';
/** Fila de N senders acima disto: pula quadro de conteúdo em vez de acumular latência. */
const ATRASO_TOLERADO = 2;

export class CodificadorWebCodecs implements CodificadorUnico {
  private encoder: VideoEncoder | null = null;
  private leitor: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private alvo: AlvoDoCodificador | null = null;
  private configurado: AlvoDoCodificador | null = null;
  private seq = 0;
  private pedirChaveAgora = true;
  private ultimaChave = -Infinity;
  private atraso = 0;
  private idrs = 0;
  private readonly pedidos: Record<string, number> = {};
  private hardware: boolean | null = null;
  private descartesPorSobrecarga = 0;
  private readonly entrada = new Map<number, number>(); // timestamp → quando entrou
  private somaMs = 0;
  private amostrasMs = 0;
  private marca = { t: 0, quadros: 0 };
  private quadros = 0;

  constructor(
    private readonly entregar: (chunk: ChunkInjetado, transferir: Transferable[]) => void,
    private readonly agora: () => number = () => performance.now(),
    /** Chamado a cada quadro capturado, codificado ou não: o relógio da isca. */
    private readonly aoCapturar: () => void = () => undefined,
  ) {}

  async iniciar(track: MediaStreamTrack, alvo: AlvoDoCodificador): Promise<void> {
    this.alvo = alvo;
    this.encoder = new VideoEncoder({
      output: (chunk) => this.saiu(chunk),
      error: () => {
        // Encoder morto: o próximo `configurar` recria. Sem isto a transmissão
        // ficaria muda com os senders vivos.
        this.encoder = null;
        this.configurado = null;
      },
    });
    try {
      const s = await VideoEncoder.isConfigSupported({ ...this.config(alvo), hardwareAcceleration: 'prefer-hardware' });
      this.hardware = s.supported === true;
    } catch {
      this.hardware = null;
    }
    this.aplicar();
    this.marca = { t: this.agora(), quadros: 0 };
    this.lerDe(track);
  }

  configurar(alvo: AlvoDoCodificador): void {
    this.alvo = alvo;
    this.aplicar();
  }

  /** Troca a captura sem derrubar ninguém: o próximo quadro é IDR. */
  trocarFonte(track: MediaStreamTrack): void {
    void this.leitor?.cancel();
    this.pedirChave();
    this.lerDe(track);
  }

  /**
   * Pedidos em rajada viram um IDR: um por `janelaDeChaveMs(senders, motivo)`.
   * O pedido dentro da janela não fica pendente — o worker repete a cada vaga
   * enquanto o sender espera, então ele volta sozinho quando a janela abre.
   * Sem `senders` (quem chama não é o worker) vale o piso de 500 ms.
   */
  pedirChave(motivo = 'outro', senders = 0): void {
    this.pedidos[motivo] = (this.pedidos[motivo] ?? 0) + 1;
    if (this.agora() - this.ultimaChave >= janelaDeChaveMs(senders, motivo)) this.pedirChaveAgora = true;
  }

  definirAtraso(quadros: number): void {
    this.atraso = quadros;
  }

  estatisticas(): EstatisticasDoCodificador {
    const agora = this.agora();
    const dt = Math.max(0.001, (agora - this.marca.t) / 1000);
    const fps = (this.quadros - this.marca.quadros) / dt;
    this.marca = { t: agora, quadros: this.quadros };
    const msPorQuadro = this.amostrasMs === 0 ? null : this.somaMs / this.amostrasMs;
    this.somaMs = 0;
    this.amostrasMs = 0;
    const sobrecarregado = this.descartesPorSobrecarga > 0;
    this.descartesPorSobrecarga = 0;
    const c = this.configurado;
    return {
      width: c?.width ?? 0,
      height: c?.height ?? 0,
      fps,
      msPorQuadro,
      bitrateAlvo: c?.bitrate ?? 0,
      hardware: this.hardware,
      sobrecarregado,
      idrs: this.idrs,
      pedidosDeChave: { ...this.pedidos },
      implementacao:
        this.hardware === null ? 'WebCodecs' : this.hardware ? 'WebCodecs·hardware' : 'WebCodecs·software',
    };
  }

  /** A trilha diz o tamanho da captura. */
  fonte(): null {
    return null;
  }

  parar(): void {
    void this.leitor?.cancel();
    this.leitor = null;
    try {
      this.encoder?.close();
    } catch {
      // já fechado
    }
    this.encoder = null;
  }

  private config(alvo: AlvoDoCodificador): VideoEncoderConfig {
    return {
      codec: CODEC,
      width: alvo.width,
      height: alvo.height,
      bitrate: alvo.bitrate,
      framerate: alvo.fps,
      latencyMode: 'realtime',
      bitrateMode: 'variable',
      avc: { format: 'annexb' },
      hardwareAcceleration: 'no-preference',
    };
  }

  /**
   * Reconfigura só quando muda de verdade. Bitrate oscilando menos de 5% não
   * reconfigura: cada `configure` pode custar um quadro-chave.
   */
  private aplicar(): void {
    const alvo = this.alvo;
    if (alvo === null) return;
    if (this.encoder === null) {
      this.encoder = new VideoEncoder({
        output: (chunk) => this.saiu(chunk),
        error: () => {
          this.encoder = null;
          this.configurado = null;
        },
      });
      this.configurado = null;
    }
    const c = this.configurado;
    const mudouTamanho = c === null || c.width !== alvo.width || c.height !== alvo.height || c.fps !== alvo.fps;
    const mudouBitrate = c === null || Math.abs(c.bitrate - alvo.bitrate) / Math.max(1, c.bitrate) > 0.05;
    if (!mudouTamanho && !mudouBitrate) return;
    this.encoder.configure(this.config(alvo));
    this.configurado = alvo;
    if (mudouTamanho) this.pedirChaveAgora = true;
  }

  private lerDe(track: MediaStreamTrack): void {
    const leitor = new MediaStreamTrackProcessor<VideoFrame>({ track }).readable.getReader();
    this.leitor = leitor;
    void (async () => {
      for (;;) {
        const { value: quadro, done } = await leitor.read();
        if (done || quadro === undefined) return;
        this.aoCapturar();
        this.codificar(quadro);
      }
    })();
  }

  private codificar(quadro: VideoFrame): void {
    const enc = this.encoder;
    if (enc === null || enc.state !== 'configured') {
      quadro.close();
      return;
    }
    // O encoder não dá conta: descarta na entrada, nunca acumula.
    if (enc.encodeQueueSize > 2) {
      this.descartesPorSobrecarga += 1;
      quadro.close();
      return;
    }
    // Contrapressão dos senders — exceto quando um IDR foi pedido.
    if (this.atraso >= ATRASO_TOLERADO && !this.pedirChaveAgora) {
      quadro.close();
      return;
    }
    const chave = this.pedirChaveAgora;
    if (chave) {
      this.pedirChaveAgora = false;
      this.ultimaChave = this.agora();
    }
    this.entrada.set(quadro.timestamp, this.agora());
    enc.encode(quadro, { keyFrame: chave });
    quadro.close();
  }

  private saiu(chunk: EncodedVideoChunk): void {
    const entrou = this.entrada.get(chunk.timestamp);
    if (entrou !== undefined) {
      this.somaMs += this.agora() - entrou;
      this.amostrasMs += 1;
      this.entrada.delete(chunk.timestamp);
    }
    if (this.entrada.size > 120) this.entrada.clear();
    this.quadros += 1;
    const chave = chunk.type === 'key';
    if (chave) this.idrs += 1;
    const dados = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(dados);
    const c = this.configurado;
    this.entregar(
      { seq: this.seq++, chave, dados, width: c?.width ?? 0, height: c?.height ?? 0 },
      [dados],
    );
  }
}
