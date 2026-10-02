import {
  type Aceleracao,
  AceleracaoDoCodificador,
  type MotivoDaQueda,
} from '../core/media/aceleracao-do-codificador.js';
import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { janelaDeChaveMs } from '../core/media/fila-de-injecao.js';
import { VigiaDoEncoder } from '../core/media/vigia-do-encoder.js';
import type { CodificadorUnico, EstatisticasDoCodificador } from './codificador-unico.js';
import type { ChunkInjetado } from './injecao-worker.js';

/**
 * O codificador ÚNICO do "um encode, N envios", sobre WebCodecs.
 *
 * Lê os quadros da captura (`MediaStreamTrackProcessor`), codifica H.264 Annex
 * B uma vez e entrega cada quadro codificado a quem injeta nos senders.
 *
 * Quem codifica — GPU ou CPU — é da `AceleracaoDoCodificador` (D9,
 * docs/desktop/D9-gpu-windows.md): no app, `prefer-hardware` quando a sonda
 * diz que há (Media Foundation no Windows: NVENC, AMF, Quick Sync), com queda
 * para software se o encoder da GPU morrer ou travar no meio, e volta depois;
 * na web, o `no-preference` de sempre. O `VigiaDoEncoder` mede o tempo por
 * quadro e acusa a trava que o WebCodecs não avisa.
 */

export type OpcoesDoWebCodecs = {
  /**
   * Pedir a GPU explicitamente (`prefer-hardware`) quando a sonda diz que
   * há. O app liga; a web não, para não mudar o que hoje funciona.
   */
  readonly preferirHardware?: boolean;
};

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
  private descartesPorSobrecarga = 0;
  private readonly vigia = new VigiaDoEncoder();
  private readonly aceleracao: AceleracaoDoCodificador;
  private parado = false;
  private marca = { t: 0, quadros: 0 };
  private quadros = 0;

  constructor(
    private readonly entregar: (chunk: ChunkInjetado, transferir: Transferable[]) => void,
    private readonly agora: () => number = () => performance.now(),
    /** Chamado a cada quadro capturado, codificado ou não: o relógio da isca. */
    private readonly aoCapturar: () => void = () => undefined,
    opcoes: OpcoesDoWebCodecs = {},
  ) {
    this.aceleracao = new AceleracaoDoCodificador(opcoes.preferirHardware === true);
  }

  async iniciar(track: MediaStreamTrack, alvo: AlvoDoCodificador): Promise<void> {
    this.alvo = alvo;
    this.parado = false;
    let suportaHardware: boolean | null;
    try {
      const s = await VideoEncoder.isConfigSupported(this.config(alvo, 'prefer-hardware'));
      suportaHardware = s.supported === true;
    } catch {
      suportaHardware = null;
    }
    this.aceleracao.comecar(suportaHardware);
    // `iniciar` de novo (o comutável voltou a este caminho): nada do anterior fica aberto.
    void this.leitor?.cancel();
    this.descartar();
    this.aplicar();
    this.marca = { t: this.agora(), quadros: 0 };
    this.lerDe(track);
  }

  configurar(alvo: AlvoDoCodificador): void {
    this.alvo = alvo;
    // Hora de tentar a GPU de novo depois de uma queda: encoder novo, com IDR.
    if (this.aceleracao.voltar(this.agora())) this.descartar();
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
    const msPorQuadro = this.vigia.lerMsPorQuadro();
    const sobrecarregado = this.descartesPorSobrecarga > 0;
    this.descartesPorSobrecarga = 0;
    const c = this.configurado;
    const classe = this.aceleracao.classe();
    return {
      width: c?.width ?? 0,
      height: c?.height ?? 0,
      fps,
      msPorQuadro,
      bitrateAlvo: c?.bitrate ?? 0,
      hardware: classe === 'desconhecido' ? null : classe === 'hardware',
      sobrecarregado,
      idrs: this.idrs,
      pedidosDeChave: { ...this.pedidos },
      implementacao: this.aceleracao.rotulo(),
    };
  }

  /** A trilha diz o tamanho da captura. */
  fonte(): null {
    return null;
  }

  parar(): void {
    this.parado = true;
    void this.leitor?.cancel();
    this.leitor = null;
    this.descartar();
  }

  private config(alvo: AlvoDoCodificador, aceleracao: Aceleracao): VideoEncoderConfig {
    return {
      codec: CODEC,
      width: alvo.width,
      height: alvo.height,
      bitrate: alvo.bitrate,
      framerate: alvo.fps,
      latencyMode: 'realtime',
      bitrateMode: 'variable',
      avc: { format: 'annexb' },
      hardwareAcceleration: aceleracao,
    };
  }

  /** Fecha o encoder atual, se houver; o próximo `aplicar` cria outro, com IDR. */
  private descartar(): void {
    const enc = this.encoder;
    this.encoder = null;
    this.configurado = null;
    try {
      enc?.close();
    } catch {
      // já fechado
    }
  }

  private novoEncoder(): VideoEncoder {
    const enc: VideoEncoder = new VideoEncoder({
      output: (chunk) => this.saiu(chunk),
      // Pode vir DENTRO do `configure`: o Chromium chama `error` na hora
      // quando a configuração é recusada (medido). `aplicar` confere depois.
      error: () => this.morreu(enc, 'erro'),
    });
    return enc;
  }

  /**
   * O encoder morreu (`error`) ou travou (vigia). A política diz o modo do
   * próximo; recriar já é numa microtarefa — nunca dentro do `configure` ou
   * do `encode` que acabou de falhar. Sem recriar já, ele volta no próximo
   * `configurar` (~1 s), como sempre foi: sem isso a transmissão ficaria muda
   * com os senders vivos.
   */
  private morreu(enc: VideoEncoder, motivo: MotivoDaQueda): void {
    if (enc !== this.encoder) return; // um antigo, já substituído
    this.descartar();
    const { recriarJa } = this.aceleracao.falhou(motivo, this.agora());
    if (!recriarJa) return;
    queueMicrotask(() => {
      if (!this.parado && this.encoder === null) this.aplicar();
    });
  }

  /**
   * Reconfigura só quando muda de verdade. Bitrate oscilando menos de 5% não
   * reconfigura: cada `configure` pode custar um quadro-chave.
   */
  private aplicar(): void {
    const alvo = this.alvo;
    if (alvo === null || this.parado) return;
    if (this.encoder === null) {
      this.encoder = this.novoEncoder();
      this.configurado = null;
      this.vigia.reiniciar(this.agora());
    }
    const enc = this.encoder;
    const c = this.configurado;
    const mudouTamanho = c === null || c.width !== alvo.width || c.height !== alvo.height || c.fps !== alvo.fps;
    const mudouBitrate = c === null || Math.abs(c.bitrate - alvo.bitrate) / Math.max(1, c.bitrate) > 0.05;
    if (!mudouTamanho && !mudouBitrate) return;
    enc.configure(this.config(alvo, this.aceleracao.modo));
    // Recusado dentro do `configure`: `morreu` já cuidou, e este não é mais o encoder.
    if (this.encoder !== enc) return;
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
    // Oferecido e nada sai há tempo demais: driver travado. Troca de encoder.
    if (this.vigia.travou(this.agora())) {
      quadro.close();
      this.morreu(enc, 'travou');
      return;
    }
    // O encoder não dá conta: descarta na entrada, nunca acumula.
    if (enc.encodeQueueSize > 2) {
      this.descartesPorSobrecarga += 1;
      this.vigia.recusado();
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
    this.vigia.entrou(quadro.timestamp, this.agora());
    enc.encode(quadro, { keyFrame: chave });
    quadro.close();
  }

  private saiu(chunk: EncodedVideoChunk): void {
    this.vigia.saiu(chunk.timestamp, this.agora());
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
