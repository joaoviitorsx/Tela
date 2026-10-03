import {
  type Aceleracao,
  AceleracaoDoCodificador,
  type MotivoDaQueda,
} from '../core/media/aceleracao-do-codificador.js';
import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { type PerfilH264, codecDoPerfil, nomeDoPerfilIdc, perfilDoSps } from '../core/media/perfil-h264.js';
import { CODEC_AV1, type CodecDaSala, codecDoEncoder, mimeDoCodec } from '../core/media/codec-da-sala.js';
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
  /**
   * O `bitrateMode`, lido a cada configuração. Ausente = `variable`, como
   * sempre. O app passa o ajuste experimental "Taxa constante".
   */
  readonly modoDeTaxa?: () => 'variable' | 'constant';
  /**
   * AV1 (ADR 0035). `hardware` (padrão): só se o encoder AV1 de hardware
   * existir e o modo for `prefer-hardware`. `forcado`: aceita software — só
   * para o teste de ponta a ponta (AV1 por software a 1080p60 pesa no jogo).
   */
  readonly av1?: 'hardware' | 'forcado';
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
/** Vigia do `detail`: quadros-chave espontâneos tolerados por janela. */
const JANELA_DE_CHAVES_MS = 10_000;
const CHAVES_ESPONTANEAS_MAX = 3;
export const REENVIO_MS = 500;

export class CodificadorWebCodecs implements CodificadorUnico {
  private encoder: VideoEncoder | null = null;
  private leitor: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private alvo: AlvoDoCodificador | null = null;
  private configurado: AlvoDoCodificador | null = null;
  /** O perfil com que o encoder atual foi configurado. */
  private perfilConfigurado: PerfilH264 | null = null;
  private readonly modoDeTaxa: () => 'variable' | 'constant';
  private readonly av1: 'hardware' | 'forcado';
  /** O encoder deste modo faz AV1 (`isConfigSupported`); `undefined` = não perguntado. */
  private av1Suportado: boolean | undefined = undefined;
  /** O codec do `configure` atual, e o do último pedido (ver `morreu`). */
  private codecConfigurado: CodecDaSala | null = null;
  private codecPedido: CodecDaSala = 'h264';
  /** O modo de aceleração do último pedido: o AV1 tem o seu (ver `modoDoCodec`). */
  private modoPedido: Aceleracao = 'no-preference';
  /**
   * O codec dos chunks que estão SAINDO. Muda no primeiro chunk que traz
   * `decoderConfig` — não no `configure`: os quadros já na fila do encoder
   * saem depois dele, ainda no codec anterior (medido, inclusive um IDR).
   */
  private codecDaSaida: CodecDaSala = 'h264';
  /** O `bitrateMode` do `configure` atual. */
  private taxaConfigurada: 'variable' | 'constant' | null = null;
  /**
   * Main é perguntado POR MODO de aceleração antes de ser usado: um
   * `configure` recusado viraria "a GPU morreu" para a política de
   * aceleração, e ela cairia para software à toa.
   */
  private readonly suportaMain = new Map<string, boolean>();
  private readonly perguntandoMain = new Set<string>();
  /** L1T2 (ADR 0034), perguntado por modo, codec e perfil EFETIVOS (`chaveDeCamadas`). */
  private readonly suportaCamadas = new Map<string, boolean>();
  private readonly perguntandoCamadas = new Set<string>();
  /** As camadas do `configure` atual. */
  private camadasConfiguradas: 1 | 2 | null = null;
  /** O último `configure` pediu L1T2 (ver `morreu`). */
  private camadasPedidas: 1 | 2 = 1;
  /** O `contentHint` do `configure` atual. */
  private conteudoConfigurado: 'motion' | 'detail' | null = null;
  /**
   * `detail` soltou quadros-chave que ninguém pediu: proibido nesta sessão.
   * Medido no encoder de software (OpenH264, revisão de 2026-10-03): o modo
   * de conteúdo de tela solta UM IDR POR QUADRO em cena com grão ou textura —
   * 120 chaves em 120 quadros, 13× o alvo. Em "um encode" isso vai a todos.
   * Por isso `detail` só vai a encoder de HARDWARE, e com este vigia.
   */
  private detailProibido = false;
  /** Quadros-chave pedidos (`keyFrame: true`) ainda sem saída. */
  private chavesPedidas = 0;
  /** Instantes de quadros-chave que o encoder soltou sozinho. */
  private chavesEspontaneas: number[] = [];
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
  /** Bytes produzidos desde a última leitura de estatísticas. */
  private bytesProduzidos = 0;
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
    this.modoDeTaxa = opcoes.modoDeTaxa ?? (() => 'variable');
    this.av1 = opcoes.av1 ?? 'hardware';
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
    void this.perguntarAv1(alvo);
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
    const bitrateProduzido = (this.bytesProduzidos * 8) / dt;
    this.bytesProduzidos = 0;
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
      bitrateProduzido,
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

  /**
   * AV1 por hardware nesta máquina? Pergunta uma vez, em `prefer-hardware`
   * (ou em qualquer modo, se forçado para teste).
   */
  private async perguntarAv1(alvo: AlvoDoCodificador): Promise<void> {
    if (this.av1Suportado !== undefined || typeof VideoEncoder.isConfigSupported !== 'function') return;
    const modo: Aceleracao = this.av1 === 'forcado' ? 'no-preference' : 'prefer-hardware';
    try {
      const r = await VideoEncoder.isConfigSupported({ ...this.config(alvo, modo), codec: CODEC_AV1 });
      this.av1Suportado = r.supported === true;
    } catch {
      this.av1Suportado = false;
    }
  }

  /**
   * A sondagem é em `prefer-hardware`, que o Chromium só confirma com encoder
   * de hardware — e o AV1 sempre configura nesse modo (`modoDoCodec`). Exigir
   * a classe medida da aceleração deixava o AV1 morto no navegador, onde o
   * H.264 roda em `no-preference` e a classe nunca é medida.
   */
  suportaAv1(): boolean {
    return this.av1Suportado === true;
  }

  /** AV1 só em hardware (fora do teste): `no-preference` cairia calado no libaom. */
  private modoDoCodec(codec: CodecDaSala): Aceleracao {
    return codec === 'av1' && this.av1 !== 'forcado' ? 'prefer-hardware' : this.aceleracao.modo;
  }

  private codecEfetivo(alvo: AlvoDoCodificador): CodecDaSala {
    return alvo.codec === 'av1' && this.suportaAv1() ? 'av1' : 'h264';
  }

  /** L1T2 só com a sala pedindo e o modo de aceleração confirmando. */
  private camadasEfetivas(alvo: AlvoDoCodificador, modo: Aceleracao, codec: CodecDaSala, perfil: PerfilH264): 1 | 2 {
    if (alvo.camadas !== 2) return 1;
    const chave = chaveDeCamadas(modo, codec, perfil);
    const sabido = this.suportaCamadas.get(chave);
    if (sabido === undefined) this.perguntarCamadas(alvo, modo, codec, perfil);
    return sabido === true ? 2 : 1;
  }

  /** A combinação que vai rodar: AV1 + L1T2 e Main + L1T2 não se deduzem de Baseline + L1T2. */
  private perguntarCamadas(alvo: AlvoDoCodificador, modo: Aceleracao, codec: CodecDaSala, perfil: PerfilH264): void {
    const chave = chaveDeCamadas(modo, codec, perfil);
    if (this.suportaCamadas.has(chave) || this.perguntandoCamadas.has(chave) || typeof VideoEncoder.isConfigSupported !== 'function') return;
    this.perguntandoCamadas.add(chave);
    void VideoEncoder.isConfigSupported(this.config(alvo, modo, perfil, 2, codec))
      .then((r) => r.supported === true)
      .catch(() => false)
      .then((sim) => {
        this.suportaCamadas.set(chave, sim);
        this.perguntandoCamadas.delete(chave);
        if (sim && this.encoder !== null) this.aplicar();
      });
  }

  /** `detail` só com a sala pedindo, encoder de hardware certo e o vigia sem queixa. */
  private conteudoEfetivo(alvo: AlvoDoCodificador): 'motion' | 'detail' {
    return alvo.conteudo === 'detail' && !this.detailProibido && this.aceleracao.classe() === 'hardware'
      ? 'detail'
      : 'motion';
  }

  private config(
    alvo: AlvoDoCodificador,
    aceleracao: Aceleracao,
    perfil: PerfilH264 = 'baseline',
    camadas: 1 | 2 = 1,
    codec: CodecDaSala = 'h264',
  ): VideoEncoderConfig {
    return {
      ...(camadas === 2 ? { scalabilityMode: 'L1T2' } : {}),
      codec: codecDoEncoder(codec, perfil),
      width: alvo.width,
      height: alvo.height,
      bitrate: alvo.bitrate,
      framerate: alvo.fps,
      latencyMode: 'realtime',
      bitrateMode: this.modoDeTaxa(),
      // A metade da R5 que não chegava aqui: `detail` no modo nitidez.
      contentHint: this.conteudoEfetivo(alvo),
      ...(codec === 'h264' ? { avc: { format: 'annexb' as const } } : {}),
      hardwareAcceleration: aceleracao,
    };
  }

  /** O rótulo do console: aceleração e o perfil EMITIDO, quando já se sabe. */
  private rotulo(): string {
    const base = this.aceleracao.rotulo();
    const camadas = this.camadasConfiguradas === 2 ? ' · L1T2' : '';
    if (this.codecConfigurado === 'av1') return `${base} · AV1${camadas}`;
    const perfil = nomeDoPerfilIdc(this.perfilEmitido);
    return perfil === null ? `${base}${camadas}` : `${base} · H.264 ${perfil}${camadas}`;
  }

  /** Fecha o encoder atual, se houver; o próximo `aplicar` cria outro, com IDR. */
  private descartar(): void {
    const enc = this.encoder;
    this.encoder = null;
    this.configurado = null;
    this.perfilConfigurado = null;
    this.taxaConfigurada = null;
    this.conteudoConfigurado = null;
    this.camadasConfiguradas = null;
    this.codecConfigurado = null;
    this.chavesPedidas = 0;
    this.ultimoTimestamp = -Infinity;
    try {
      enc?.close();
    } catch {
      // já fechado
    }
  }

  private novoEncoder(): VideoEncoder {
    const enc: VideoEncoder = new VideoEncoder({
      // `svc` existe no Chromium com `scalabilityMode`; o lib.dom ainda não traz.
      output: (chunk, meta) => {
        const codec = meta?.decoderConfig?.codec;
        if (codec !== undefined) this.codecDaSaida = codec.startsWith('av01') ? 'av1' : 'h264';
        this.saiu(chunk, (meta as { svc?: { temporalLayerId?: number } } | undefined)?.svc?.temporalLayerId);
      },
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
    const arriscado = this.perfilPedido === 'main' || this.camadasPedidas === 2 || this.codecPedido === 'av1';
    if (motivo === 'erro' && arriscado && this.saidasDoPerfil === 0) {
      /*
        Um recurso por vez, do que vale menos para o que vale mais: AV1 que
        recusa L1T2 continua AV1 em L1T1, em vez de perder os dois pela
        sessão inteira. Se ainda falhar, a próxima queda tira o seguinte.
      */
      const perfilPedido = this.perfilPedido ?? 'baseline';
      if (this.camadasPedidas === 2) this.suportaCamadas.set(chaveDeCamadas(this.modoPedido, this.codecPedido, perfilPedido), false);
      else if (this.perfilPedido === 'main') this.suportaMain.set(this.modoPedido, false);
      else this.av1Suportado = false;
      this.descartar();
      queueMicrotask(() => {
        if (!this.parado && this.encoder === null) this.aplicar();
      });
      return;
    }
    /*
      AV1 que morre depois de já ter saído quadro: é o AV1 (o caminho de
      hardware dele), não a aceleração do H.264 — a sala volta a H.264 sem
      cobrar a política. Os senders ficam com isca AV1 e quadro H.264; o
      descompasso vira aviso de `entrada` no worker, e o transporte realinha.
    */
    if (this.codecPedido === 'av1') {
      this.av1Suportado = false;
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
    const codec = this.codecEfetivo(alvo);
    const modo = this.modoDoCodec(codec);
    // Perfil H.264 só vale com a sala em H.264: com AV1, mudar o piso não reconfigura (nem solta IDR).
    const perfil: PerfilH264 = codec === 'h264' ? this.perfilEfetivo(alvo) : (this.perfilConfigurado ?? 'baseline');
    const mudouTamanho = c === null || c.width !== alvo.width || c.height !== alvo.height || c.fps !== alvo.fps;
    const mudouBitrate =
      c === null ||
      Math.abs(c.bitrate - alvo.bitrate) / Math.max(1, c.bitrate) > 0.05 ||
      this.conteudoEfetivo(alvo) !== this.conteudoConfigurado;
    // Trocar de perfil é como trocar de tamanho: SPS novo, e o próximo quadro tem de ser IDR.
    const mudouPerfil = perfil !== this.perfilConfigurado;
    const mudouTaxa = this.modoDeTaxa() !== this.taxaConfigurada;
    const camadas = this.camadasEfetivas(alvo, modo, codec, perfil);
    const mudouCamadas = camadas !== this.camadasConfiguradas;
    const mudouCodec = codec !== this.codecConfigurado;
    if (!mudouTamanho && !mudouBitrate && !mudouPerfil && !mudouTaxa && !mudouCamadas && !mudouCodec) return;
    if (mudouPerfil || mudouCamadas || mudouCodec || c === null) {
      this.perfilPedido = perfil;
      this.camadasPedidas = camadas;
      this.codecPedido = codec;
      this.modoPedido = modo;
      this.saidasDoPerfil = 0;
      this.entradaNoConfigure = this.ultimaEntrada;
    }
    enc.configure(this.config(alvo, modo, perfil, camadas, codec));
    // Recusado dentro do `configure`: `morreu` já cuidou, e este não é mais o encoder.
    if (this.encoder !== enc) return;
    this.configurado = alvo;
    this.perfilConfigurado = perfil;
    this.taxaConfigurada = this.modoDeTaxa();
    this.conteudoConfigurado = this.conteudoEfetivo(alvo);
    this.camadasConfiguradas = camadas;
    this.codecConfigurado = codec;
    if (mudouTamanho || mudouPerfil || mudouTaxa || mudouCamadas || mudouCodec) this.pedirChaveAgora = true;
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
    if (chave) this.chavesPedidas += 1;
    enc.encode(entrada, { keyFrame: chave });
    entrada.close();
    if (entrada !== quadro) quadro.close();
  }

  /**
   * Quadro-chave que ninguém pediu. Três em 10 s com `detail` ligado: é a
   * detecção de cena do modo de conteúdo de tela — volta a `motion`.
   */
  private chaveEspontanea(): void {
    const agora = this.agora();
    this.chavesEspontaneas = this.chavesEspontaneas.filter((t) => agora - t < JANELA_DE_CHAVES_MS);
    this.chavesEspontaneas.push(agora);
    if (this.conteudoConfigurado === 'detail' && this.chavesEspontaneas.length >= CHAVES_ESPONTANEAS_MAX) {
      this.detailProibido = true;
      queueMicrotask(() => this.aplicar());
    }
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

  private saiu(chunk: EncodedVideoChunk, camada?: number): void {
    if (chunk.timestamp > this.entradaNoConfigure) this.saidasDoPerfil += 1;
    this.vigia.saiu(chunk.timestamp, this.agora());
    this.quadros += 1;
    const chave = chunk.type === 'key';
    if (chave) {
      this.idrs += 1;
      if (this.chavesPedidas > 0) this.chavesPedidas -= 1;
      else this.chaveEspontanea();
    }
    this.bytesProduzidos += chunk.byteLength;
    const dados = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(dados);
    // O perfil de fato sai do SPS, que só vem em quadro-chave: custo zero no resto.
    if (chave && this.codecDaSaida === 'h264') this.perfilEmitido = perfilDoSps(new Uint8Array(dados)) ?? this.perfilEmitido;
    /*
      Timestamp voltando = o encoder reordenou quadros (B-frames). O
      receptor em tempo real não espera por isso; Main fica proibido e o
      encoder volta a Baseline — que não tem B-frames — com IDR.
    */
    if (chunk.timestamp < this.ultimoTimestamp && this.perfilConfigurado === 'main' && this.codecConfigurado === 'h264') {
      this.mainProibido = true;
      queueMicrotask(() => this.aplicar());
    }
    this.ultimoTimestamp = Math.max(this.ultimoTimestamp, chunk.timestamp);
    const c = this.configurado;
    this.entregar(
      {
        seq: this.seq++,
        chave,
        dados,
        width: c?.width ?? 0,
        height: c?.height ?? 0,
        // Só com L1T2 configurado: sem camadas, a válvula não tem o que pular.
        ...(this.camadasConfiguradas === 2 && camada !== undefined ? { camada } : {}),
        mime: mimeDoCodec(this.codecDaSaida),
      },
      [dados],
    );
  }
}

function chaveDeCamadas(modo: Aceleracao, codec: CodecDaSala, perfil: PerfilH264): string {
  return `${modo}|${codec}|${codec === 'av1' ? '-' : perfil}`;
}
