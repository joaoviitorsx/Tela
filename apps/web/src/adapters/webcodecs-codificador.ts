import {
  type Aceleracao,
  AceleracaoDoCodificador,
  type MotivoDaQueda,
} from '../core/media/aceleracao-do-codificador.js';
import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { type PerfilH264, codecDoPerfil, nomeDoPerfilIdc, perfilDoSps } from '../core/media/perfil-h264.js';
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
 * H.264 Constrained Baseline nível 4.2: cobre 1080p60, e é o piso que todo
 * receptor decodifica. Main entra quando a SALA inteira aceita
 * (`perfil-h264.ts`) e o encoder deste modo de aceleração diz que faz.
 */
export const CODEC = codecDoPerfil('baseline');
/** Fila de N senders acima disto: pula quadro de conteúdo em vez de acumular latência. */
const ATRASO_TOLERADO = 2;
/**
 * Sem quadro novo da captura por este tempo, o último é codificado de novo —
 * no máximo a cada `REENVIO_MS`, ou já, se alguém pediu quadro-chave.
 *
 * A captura só solta quadro quando a imagem muda, e para de vez quando o jogo
 * minimiza (Alt+Tab num jogo em tela cheia). Como a isca só gera vaga a cada
 * quadro capturado, nada saía: quem assistia congelava, quem entrava nessa
 * hora ficava no preto, e os pedidos de quadro-chave dos espectadores não
 * tinham como ser atendidos (relato de 02/10: "dá Alt+Tab e volta e a tela
 * fica travada"; o diagnóstico do espectador mostrava 0 kbps com a ligação
 * viva). Reenviar o último quadro custa um P quase vazio a 2 fps.
 */
export const SEM_CAPTURA_MS = 500;
const MODOS: readonly Aceleracao[] = ['prefer-hardware', 'no-preference', 'prefer-software'];
export const REENVIO_MS = 500;

export class CodificadorWebCodecs implements CodificadorUnico {
  private encoder: VideoEncoder | null = null;
  private leitor: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private alvo: AlvoDoCodificador | null = null;
  private configurado: AlvoDoCodificador | null = null;
  /** O perfil com que o encoder atual foi configurado. */
  private perfilConfigurado: PerfilH264 | null = null;
  /**
   * Main é perguntado POR MODO de aceleração antes de ser usado: um
   * `configure` recusado viraria "a GPU morreu" para a política de
   * aceleração, e ela cairia para software à toa.
   */
  private readonly suportaMain = new Map<string, boolean>();
  private readonly perguntandoMain = new Set<string>();
  /** Saiu quadro fora de ordem (B-frames): Main fica proibido nesta sessão. */
  private mainProibido = false;
  private ultimoTimestamp = -Infinity;
  /** O perfil do ÚLTIMO `configure` — gravado antes dele, porque o erro pode vir de dentro. */
  private perfilPedido: PerfilH264 | null = null;
  /** Quadros que saíram desde aquele `configure`: zero = o perfil nunca funcionou. */
  private saidasDoPerfil = 0;
  /**
   * O último carimbo de entrada antes daquele `configure`. Só conta como
   * saída DO perfil novo o quadro que entrou depois — saídas atrasadas do
   * perfil anterior não provam que o novo funciona.
   */
  private entradaNoConfigure = -Infinity;
  /**
   * Carimbos de ENTRADA monotônicos. Cada trilha nova (pausa, retomada, troca
   * de tela) recomeça o `timestamp` do `VideoFrame` em ~0, e o reenvio do
   * último quadro carimba à frente do que ainda está na fila. `desvio`
   * desloca a entrada para nunca voltar — mantendo o espaçamento real, que é
   * o que o controle de taxa do encoder lê. Assim, timestamp voltando na
   * SAÍDA só pode ser reordenação de verdade (B-frames).
   */
  private ultimaEntrada = -Infinity;
  private desvio = 0;
  /** `profile_idc` do último SPS emitido: o perfil de FATO, não o pedido. */
  private perfilEmitido: number | null = null;
  private seq = 0;
  private pedirChaveAgora = true;
  private ultimaChave = -Infinity;
  private atraso = 0;
  private idrs = 0;
  private readonly pedidos: Record<string, number> = {};
  private descartesPorSobrecarga = 0;
  private segurados = 0;
  private readonly vigia = new VigiaDoEncoder();
  private readonly aceleracao: AceleracaoDoCodificador;
  private parado = false;
  private marca = { t: 0, quadros: 0 };
  private quadros = 0;
  /** O último quadro capturado (um clone: mesmo buffer, sem cópia), para reenviar. */
  private ultimo: VideoFrame | null = null;
  private ultimaCaptura = -Infinity;
  private ultimoReenvio = -Infinity;
  private capturados = 0;
  private marcaDaCaptura = { t: 0, quadros: 0 };

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
    // Main perguntado para os três modos já: uma queda de GPU não vira IDR duplo (Baseline, depois Main).
    for (const modo of MODOS) this.perguntarMain(alvo, modo);
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
    this.esquecerUltimo();
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

  /**
   * Chamado ~10 vezes por segundo pelo worker (que não é estrangulado com a
   * aba escondida). Ver `SEM_CAPTURA_MS`.
   */
  manterVivo(): void {
    const ultimo = this.ultimo;
    if (ultimo === null || this.parado || typeof VideoFrame !== 'function') return;
    const agora = this.agora();
    if (agora - this.ultimaCaptura < SEM_CAPTURA_MS) return;
    if (agora - this.ultimoReenvio < REENVIO_MS && !this.pedirChaveAgora) return;
    this.ultimoReenvio = agora;
    let quadro: VideoFrame;
    try {
      // Tempo andando a partir do último capturado: o encoder não vê o
      // relógio voltar quando a captura recomeçar.
      quadro = new VideoFrame(ultimo, { timestamp: ultimo.timestamp + Math.round((agora - this.ultimaCaptura) * 1000) });
    } catch {
      return;
    }
    this.aoCapturar();
    this.codificar(quadro);
  }

  estatisticas(): EstatisticasDoCodificador {
    const agora = this.agora();
    const dt = Math.max(0.001, (agora - this.marca.t) / 1000);
    const fps = (this.quadros - this.marca.quadros) / dt;
    this.marca = { t: agora, quadros: this.quadros };
    const msPorQuadro = this.vigia.lerMsPorQuadro();
    const sobrecarregado = this.descartesPorSobrecarga > 0;
    this.descartesPorSobrecarga = 0;
    const segurados = this.segurados;
    this.segurados = 0;
    const dtCaptura = Math.max(0.001, (agora - this.marcaDaCaptura.t) / 1000);
    const fpsDaCaptura = (this.capturados - this.marcaDaCaptura.quadros) / dtCaptura;
    this.marcaDaCaptura = { t: agora, quadros: this.capturados };
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
      segurados,
      fpsDaCaptura,
      idrs: this.idrs,
      pedidosDeChave: { ...this.pedidos },
      implementacao: this.rotulo(),
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
    this.esquecerUltimo();
    this.descartar();
  }

  /** Main só com a sala pedindo, o modo atual confirmando e nenhum B-frame visto. */
  private perfilEfetivo(alvo: AlvoDoCodificador): PerfilH264 {
    if (alvo.perfil !== 'main' || this.mainProibido) return 'baseline';
    const modo = this.aceleracao.modo;
    const sabido = this.suportaMain.get(modo);
    if (sabido === undefined) this.perguntarMain(alvo, modo);
    return sabido === true ? 'main' : 'baseline';
  }

  private perguntarMain(alvo: AlvoDoCodificador, modo: Aceleracao): void {
    // Já sabido (inclusive o `false` de um configure que estourou): não pergunta de novo.
    if (this.suportaMain.has(modo) || this.perguntandoMain.has(modo) || typeof VideoEncoder.isConfigSupported !== 'function') return;
    this.perguntandoMain.add(modo);
    void VideoEncoder.isConfigSupported(this.config(alvo, modo, 'main'))
      .then((r) => r.supported === true)
      .catch(() => false)
      .then((sim) => {
        this.suportaMain.set(modo, sim);
        this.perguntandoMain.delete(modo);
        // Sim: reconfigura já (com IDR); não: fica em Baseline, nada muda. Sem
        // encoder vivo (caiu e a política mandou esperar) quem recria é ela.
        if (sim && this.encoder !== null) this.aplicar();
      });
  }

  private config(alvo: AlvoDoCodificador, aceleracao: Aceleracao, perfil: PerfilH264 = 'baseline'): VideoEncoderConfig {
    return {
      codec: codecDoPerfil(perfil),
      width: alvo.width,
      height: alvo.height,
      bitrate: alvo.bitrate,
      framerate: alvo.fps,
      latencyMode: 'realtime',
      bitrateMode: 'variable',
      // A metade da R5 que não chegava aqui: `detail` no modo nitidez.
      contentHint: alvo.conteudo,
      avc: { format: 'annexb' },
      hardwareAcceleration: aceleracao,
    };
  }

  /** O rótulo do console: aceleração e o perfil EMITIDO, quando já se sabe. */
  private rotulo(): string {
    const perfil = nomeDoPerfilIdc(this.perfilEmitido);
    const base = this.aceleracao.rotulo();
    return perfil === null ? base : `${base} · H.264 ${perfil}`;
  }

  /** Fecha o encoder atual, se houver; o próximo `aplicar` cria outro, com IDR. */
  private descartar(): void {
    const enc = this.encoder;
    this.encoder = null;
    this.configurado = null;
    this.perfilConfigurado = null;
    this.ultimoTimestamp = -Infinity;
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
    /*
      Main recusado (o `isConfigSupported` disse sim e o `configure` ou o
      primeiro `encode` falhou): é o PERFIL, não a GPU. Marca o modo como sem
      Main e recria no mesmo modo — contar como queda de GPU levaria a sessão
      para software depois de três tentativas.
    */
    if (motivo === 'erro' && this.perfilPedido === 'main' && this.saidasDoPerfil === 0) {
      this.suportaMain.set(this.aceleracao.modo, false);
      this.descartar();
      queueMicrotask(() => {
        if (!this.parado && this.encoder === null) this.aplicar();
      });
      return;
    }
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
    const perfil = this.perfilEfetivo(alvo);
    const mudouTamanho = c === null || c.width !== alvo.width || c.height !== alvo.height || c.fps !== alvo.fps;
    const mudouBitrate =
      c === null || Math.abs(c.bitrate - alvo.bitrate) / Math.max(1, c.bitrate) > 0.05 || c.conteudo !== alvo.conteudo;
    // Trocar de perfil é como trocar de tamanho: SPS novo, e o próximo quadro tem de ser IDR.
    const mudouPerfil = perfil !== this.perfilConfigurado;
    if (!mudouTamanho && !mudouBitrate && !mudouPerfil) return;
    if (mudouPerfil || c === null) {
      this.perfilPedido = perfil;
      this.saidasDoPerfil = 0;
      this.entradaNoConfigure = this.ultimaEntrada;
    }
    enc.configure(this.config(alvo, this.aceleracao.modo, perfil));
    // Recusado dentro do `configure`: `morreu` já cuidou, e este não é mais o encoder.
    if (this.encoder !== enc) return;
    this.configurado = alvo;
    this.perfilConfigurado = perfil;
    if (mudouTamanho || mudouPerfil) this.pedirChaveAgora = true;
  }

  private guardarUltimo(quadro: VideoFrame): void {
    if (typeof quadro.clone !== 'function') return;
    const anterior = this.ultimo;
    try {
      this.ultimo = quadro.clone();
    } catch {
      this.ultimo = null;
    }
    anterior?.close();
  }

  private esquecerUltimo(): void {
    this.ultimo?.close();
    this.ultimo = null;
    this.ultimaCaptura = -Infinity;
  }

  private lerDe(track: MediaStreamTrack): void {
    const leitor = new MediaStreamTrackProcessor<VideoFrame>({ track }).readable.getReader();
    this.leitor = leitor;
    void (async () => {
      for (;;) {
        const { value: quadro, done } = await leitor.read();
        if (done || quadro === undefined) return;
        // Um `read` já resolvido quando a fonte trocou: o quadro é da captura
        // ANTIGA (na pausa de privacidade, a tela real). Não sai.
        if (this.leitor !== leitor) {
          quadro.close();
          return;
        }
        this.capturados += 1;
        this.ultimaCaptura = this.agora();
        this.guardarUltimo(quadro);
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
      this.segurados += 1;
      quadro.close();
      return;
    }
    const chave = this.pedirChaveAgora;
    if (chave) {
      this.pedirChaveAgora = false;
      this.ultimaChave = this.agora();
    }
    const entrada = this.monotonico(quadro);
    this.vigia.entrou(entrada.timestamp, this.agora());
    enc.encode(entrada, { keyFrame: chave });
    entrada.close();
    if (entrada !== quadro) quadro.close();
  }

  /**
   * O quadro com carimbo que nunca volta (ver `desvio`). Só embrulha quando
   * houve descontinuidade — o embrulho não copia pixel (mesmo recurso).
   */
  private monotonico(quadro: VideoFrame): VideoFrame {
    let ts = quadro.timestamp + this.desvio;
    if (ts > this.ultimaEntrada) {
      this.ultimaEntrada = ts;
      return ts === quadro.timestamp || typeof VideoFrame !== 'function' ? quadro : this.recarimbar(quadro, ts);
    }
    const passo = Math.round(1_000_000 / Math.max(1, this.configurado?.fps ?? 60));
    this.desvio += this.ultimaEntrada + passo - ts;
    ts = this.ultimaEntrada + passo;
    this.ultimaEntrada = ts;
    return typeof VideoFrame === 'function' ? this.recarimbar(quadro, ts) : quadro;
  }

  private recarimbar(quadro: VideoFrame, timestamp: number): VideoFrame {
    try {
      return new VideoFrame(quadro, { timestamp });
    } catch {
      return quadro;
    }
  }

  private saiu(chunk: EncodedVideoChunk): void {
    if (chunk.timestamp > this.entradaNoConfigure) this.saidasDoPerfil += 1;
    this.vigia.saiu(chunk.timestamp, this.agora());
    this.quadros += 1;
    const chave = chunk.type === 'key';
    if (chave) this.idrs += 1;
    const dados = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(dados);
    // O perfil de fato sai do SPS, que só vem em quadro-chave: custo zero no resto.
    if (chave) this.perfilEmitido = perfilDoSps(new Uint8Array(dados)) ?? this.perfilEmitido;
    /*
      Timestamp voltando = o encoder reordenou quadros (B-frames). O
      receptor em tempo real não espera por isso; Main fica proibido e o
      encoder volta a Baseline — que não tem B-frames — com IDR.
    */
    if (chunk.timestamp < this.ultimoTimestamp && this.perfilConfigurado === 'main') {
      this.mainProibido = true;
      queueMicrotask(() => this.aplicar());
    }
    this.ultimoTimestamp = Math.max(this.ultimoTimestamp, chunk.timestamp);
    const c = this.configurado;
    this.entregar(
      { seq: this.seq++, chave, dados, width: c?.width ?? 0, height: c?.height ?? 0 },
      [dados],
    );
  }
}
