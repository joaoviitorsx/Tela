import { Emitter } from '../emitter.js';
import { type Aprovados, aprovadosEmMemoria } from '../identity/aprovados.js';
import type { AudioCapture } from '../ports/audio-capture.js';
import type { AudioGain, EstadoGrafo } from '../ports/audio-gain.js';
import type {
  MediaStats,
  MediaTransport,
  PeerInfo,
  QualityLimitation,
} from '../ports/media-transport.js';
import type { QuadroNeutro } from '../ports/quadro-neutro.js';
import type { Scheduler } from '../ports/scheduler.js';
import type { CaptureError, CaptureSurface, ScreenCapture } from '../ports/screen-capture.js';
import { isSignalingError } from '../ports/signaling-channel.js';
import {
  CONTENT_HINT_POR_PRIORIDADE,
  FRAMERATE_POR_PRIORIDADE,
  NITIDEZ_FPS_MINIMO,
  P2P_LIMITS,
  type Prioridade,
} from '@tela/shared';
import { descreverCaptura, fonteDaSuperficie, type TipoFonteAudio } from './audio-fonte.js';
import { ClassificadorDeAudio, type EstadoAudio } from './audio-state.js';
import {
  CODIGO_AUDIO,
  CODIGO_GRAFO,
  type Diagnostico,
  Diario,
  idLocal,
} from './diagnostico.js';
import { CAPACIDADE_ATE_MEDIR, capacidadePelaBanda } from './capacidade-pela-banda.js';
import { MalhaDeBanda, encoderOcioso } from './malha-de-banda.js';
import {
  DEFAULT_PRESET_ID,
  type PresetId,
  menorPreset,
  nextPresetOnCpuPressure,
  presetById,
  presetParaOrcamento,
  previousPresetOnRecovery,
} from './presets.js';

/**
 * O coração do produto, e o único lugar onde a transmissão existe como
 * conceito.
 *
 * Classe pura: zero React, zero DOM além de `MediaStreamTrack`, zero SDK de
 * transporte. Essa restrição (AGENTS.md R1) já se pagou uma vez — quando o
 * transporte trocou de SFU para mesh (changeset 001), a máquina de estados,
 * as regras de mídia e a degradação por CPU deste arquivo continuaram
 * valendo. Mudou quem implementa a porta, não quem a usa.
 */
export type BroadcastFailure =
  | 'CAPTURE_DENIED'
  | 'CAPTURE_FAILED'
  | 'CAPTURE_UNSUPPORTED'
  | 'SLUG_TAKEN'
  | 'SLUG_INVALID'
  | 'RATE_LIMITED'
  /** Cliente de outra versão do protocolo: recarregar a página resolve. */
  | 'OUTDATED'
  | 'SIGNALING_UNAVAILABLE'
  | 'TRANSPORT_FAILED'
  | 'USER_STOPPED'
  | 'CAPTURE_ENDED';

/**
 * União discriminada: estado impossível não é representável.
 * Não existe `live` sem link, nem `ended` sem motivo.
 */
/** Alguém esperando o dono responder (ADR 0025). */
export type PedidoPendente = {
  readonly peerId: string;
  readonly nome: string;
  /** Quando o pedido chegou, no relógio do scheduler. */
  readonly desde: number;
};

export type BroadcastState =
  | { readonly status: 'idle' }
  | { readonly status: 'requesting-capture' }
  | { readonly status: 'connecting' }
  | {
      readonly status: 'live';
      readonly shareUrl: string;
      readonly slug: string;
      readonly presetId: PresetId;
      /** O que a pessoa escolheu. `presetId` é o que está no ar; divergem quando a rede ou a CPU seguram. */
      readonly presetEscolhido: PresetId;
      readonly presetForced: boolean;
      readonly peers: readonly PeerInfo[];
      /** Pedidos esperando resposta, do mais antigo ao mais novo. */
      readonly pedidos: readonly PedidoPendente[];
      /** Apelido de quem já entrou, por `peerId`. */
      readonly nomes: Readonly<Record<string, string>>;
      readonly maxPeers: number;
      /**
       * Quantos o LINK paga agora, nunca acima de `maxPeers` (ADR 0030). É o
       * número que o servidor usa na porta: acima dele a próxima pessoa recebe
       * "sem vaga". Começa conservador e cada medição abre vagas.
       */
      readonly vagasPelaBanda: number;
      readonly stats: MediaStats | null;
      readonly hasAudio: boolean;
      /**
       * Volume do que os ESPECTADORES ouvem, 0 a 1.
       *
       * Não é o volume do alto-falante de quem transmite: aquele não afeta a
       * transmissão, porque a captura de som do sistema pega o stream antes
       * do volume de saída do aparelho. Sem este controle o transmissor não
       * tinha nenhuma influência sobre o que os amigos ouviam.
       */
      /**
       * A captura parou de entregar imagem AO ENCODER.
       *
       * Medido em `framesPerSecond` do `outbound-rtp`, que é literalmente o
       * que sai para os espectadores — não o que um elemento de vídeo local
       * acha. Mede a coisa certa e não custa nada: a amostragem já existia.
       */
      readonly capturaSemImagem: boolean;
      /**
       * POR QUE a qualidade caiu sozinha. `null` quando não caiu.
       *
       * `cpu` quase sempre significa encode em SOFTWARE — o caso que de fato
       * rouba quadros do jogo, e o único em que o usuário tem o que fazer
       * (ligar o encode por hardware). `bandwidth` é o link. Dizer "o encoder
       * não estava dando conta" nos dois casos manda metade das pessoas
       * caçar o problema no lugar errado.
       */
      readonly motivoDegradacao: QualityLimitation | null;
      readonly volumeAudio: number;
      /**
       * O que dá para AFIRMAR sobre o som que sai. Ver `audio-state.ts`.
       *
       * `hasAudio` diz se existe trilha; isto diz se ela está entregando —
       * volume zero escolhido, fonte que acabou e fonte muda há 20s são três
       * estados diferentes, e antes eram todos `hasAudio: true`.
       */
      readonly audio: EstadoAudio;
      /**
       * O grafo de ganho. `suspenso` quer dizer que o navegador parou o
       * processamento — a trilha segue `live` e sai SILÊNCIO — e só um gesto
       * do usuário o retoma (`retomarAudio`).
       */
      readonly grafoAudio: EstadoGrafo;
      /** `false` quando o navegador não deu Web Audio e o ganho não entrou. */
      readonly volumeAjustavel: boolean;
      /**
       * O canal de sinalização caiu. Quem já está assistindo continua vendo;
       * só espectadores novos não conseguem entrar.
       */
      readonly semSinalizacao: boolean;
      /**
       * A mídia capturada, para o transmissor ver o que está mandando.
       *
       * Também é diagnóstico: preview preto significa que a CAPTURA falhou,
       * e não a rede. Sem ela, "está preto" tem duas causas possíveis e
       * nenhuma forma de distinguir.
       */
      readonly preview: MediaStream | null;
      /** O que ceder sob aperto de rede: fluidez (padrão) ou nitidez. */
      readonly prioridade: Prioridade;
      /**
       * `true` quando o usuário escolheu uma janela ou aba em vez da tela
       * inteira NUM sistema onde isso custa o áudio do sistema.
       *
       * O navegador não avisa: ele simplesmente entrega vídeo sem som, e a
       * pessoa só descobre quando um amigo reclama.
       */
      readonly audioPerdidoPelaEscolha: boolean;
      /**
       * O som vem do SISTEMA inteiro (tela inteira + "compartilhar áudio do
       * sistema"): inclui a call do Discord, e quem está nela se escuta na
       * transmissão. A janela do jogo (Chrome 141+, `windowAudio`) e o app
       * (modo Sistema sem a call) não têm esse problema.
       */
      readonly somComCall: boolean;
      /**
       * Pausa de privacidade (TELA-022). `null` fora da pausa; dentro, se o
       * som continua. Os amigos veem o quadro neutro, a sala e a captura
       * continuam — retomar é instantâneo.
       */
      readonly pausa: { readonly comSom: boolean } | null;
    }
  | { readonly status: 'ended'; readonly reason: BroadcastFailure };

export type BroadcastEvents = {
  state: BroadcastState;
  /** Só para efeito de UI (copiar link). A sessão não conhece clipboard. */
  started: { shareUrl: string };
};

export type BroadcastSessionDeps = {
  transport: MediaTransport;
  screen: ScreenCapture;
  audio: AudioCapture;
  /** Volume do que é ENVIADO. Ver `core/ports/audio-gain.ts`. */
  gain: AudioGain;
  scheduler: Scheduler;
  /**
   * Monta o link de quem assiste: só o nome do canal (ADR 0026). Sem
   * servidor, quem sabe montar é o front.
   */
  shareUrlFor: (slug: string) => string;
  /**
   * Quem este aparelho já aceitou (ADR 0025): quem volta não pede de novo.
   * Opcional só para testes e simulador; sem ele a memória dura a sessão.
   */
  aprovados?: Aprovados;
  /**
   * Quadro da pausa de privacidade. Opcional: sem ele a pausa desliga a
   * trilha (`enabled = false`), que manda preto — neutro, mas mudo sobre o
   * motivo.
   */
  quadroNeutro?: QuadroNeutro;
  /**
   * O que o link deste aparelho sustentou da última vez, por espectador.
   *
   * Opcional: sem ele o governador simplesmente aquece do zero, como antes.
   */
  uplinkMemory?: { read(): string | null; write(value: string): void };
  /** `MediaStream` é global de browser; `core/` não constrói um direto. */
  createStream: (tracks: readonly MediaStreamTrack[]) => MediaStream;
  /**
   * Quantos espectadores ESTE transmissor consegue servir — decidido por quem
   * fia o transporte, porque depende dele: "um encode, N envios" atende o teto
   * do produto; o mesh puro codifica uma vez por peer e para em poucos.
   * Ausente = o conservador, porque assumir o maior quando ninguém disse é
   * prometer o que a máquina não entrega.
   */
  capacidade?: number;
  statsIntervalMs?: number;
  diagnosticId?: () => string;
  appVersion?: string | null;
};

const STATS_INTERVAL_MS = 1_000;
/** 128 kbps do Opus + ~10% de cabeçalhos. Ver `reservaDeAudio`. */
const RESERVA_AUDIO_BPS = 141_000;

const FALHA_DE_CAPTURA: Readonly<Record<CaptureError, BroadcastFailure>> = {
  DENIED: 'CAPTURE_DENIED',
  UNSUPPORTED: 'CAPTURE_UNSUPPORTED',
  FAILED: 'CAPTURE_FAILED',
};
/** Quantas leituras seguidas com o mesmo limitador antes de cair de preset. */
const PRESSURE_SAMPLES = 5;

/**
 * Amostras de calmaria antes de devolver um degrau. Doze vezes mais lento que
 * a descida, de propósito — ver `recuperar()`.
 */
const CALMARIA_AMOSTRAS = 60;

/**
 * O que um blip de aperto CUSTA da calmaria acumulada.
 *
 * Era tudo: `calmaria = 0`. Com uma taxa `p` de leituras de aperto isoladas —
 * keyframe, troca de cena, alt-tab —, exigir 60 amostras CONSECUTIVAS faz o
 * tempo de recuperação explodir: 83s com 1% de blips, 7 minutos com 5%,
 * 92 minutos com 10%, e nunca com 20%.
 *
 * Cobrando 5, o saldo por amostra é `(1−p) − 5p`, que continua positivo até
 * p ≈ 17%. Acima disso não é mais blip, é pressão de verdade — e aí não
 * recuperar é a resposta certa.
 */
const CALMARIA_PENALIDADE = 5;

/**
 * Amostras a zero frame antes de acusar captura morta. Cinco segundos é o que
 * uma captura leva para engatar em máquina lenta; abaixo disso é falso alarme.
 */
const SEM_IMAGEM_AMOSTRAS = 5;

/** Intervalo entre gravações da banda medida, em amostras de 1s. */
const GRAVAR_BANDA_A_CADA = 30;

/**
 * Framerate da captura quando NINGUÉM está assistindo.
 *
 * Sem espectador não há encoder rodando — mas a captura de tela continua, e
 * capturar 1080p60 é trabalho real de GPU e de compositor. Numa máquina que
 * está rodando um jogo, isso é custo cobrado por nada.
 *
 * Cinco quadros por segundo mantém a trilha viva (parar e recomeçar traria o
 * seletor de tela de volta, o que é inaceitável) e devolve praticamente todo
 * o custo. O usuário não percebe: não há ninguém do outro lado para ver.
 */
const IDLE_CAPTURE_FPS = 5;

/**
 * Tempo de graça antes de derrubar a captura para 5fps.
 *
 * Um peer pode sumir por um instante durante renegociação. Sem a graça, a
 * captura ia a 5fps e voltava a 60 na sequência, e cada troca dessas é uma
 * reconfiguração visível — travadinha causada justamente pela otimização que
 * deveria ajudar.
 */
const OCIOSO_GRACA_MS = 10_000;

/**
 * Leituras ignoradas antes de qualquer degradação automática.
 *
 * No início da transmissão o encoder ainda está subindo e o controle de
 * congestionamento ainda está sondando: `cpu` e `bandwidth` aparecem por
 * alguns segundos mesmo numa máquina folgada. Degradar aí é punir o usuário
 * por um transiente que ia passar sozinho.
 */
const AQUECIMENTO_AMOSTRAS = 8;


export class BroadcastSession {
  private readonly emitter = new Emitter<BroadcastEvents>();

  private state: BroadcastState = { status: 'idle' };
  private videoTrack: MediaStreamTrack | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  /**
   * A trilha CRUA da captura de som. `audioTrack` é a saída do grafo de ganho,
   * e ela não termina quando a fonte termina — só esta diz se o som acabou.
   */
  private audioFonte: MediaStreamTrack | null = null;
  /**
   * De onde veio o som, e portanto o que fazer com ele ao trocar a tela
   * (TELA-012). `captura`: veio junto com a tela/aba/janela e ACOMPANHA a
   * troca. `dispositivo`: sink virtual ou entrada escolhida, independente da
   * tela, e FICA.
   */
  private origemAudio: 'captura' | 'dispositivo' | null = null;
  private readonly classificadorAudio = new ClassificadorDeAudio();
  private grafoAudio: EstadoGrafo = 'indisponivel';
  private timers: Array<() => void> = [];
  private unsubscribes: Array<() => void> = [];
  /**
   * O degrau EFETIVO, o que de fato está no ar. Derivado, nunca escrito à mão.
   *
   * Três pressões independentes decidem a qualidade ao mesmo tempo, e a que
   * aperta mais é a que vale. Antes existia só este campo, mutável, e a última
   * fonte a escrever nele apagava as outras — era assim que o produto acabava
   * mandando 1920×1080@60 num orçamento de 3 Mbps (ADR 0015).
   */
  private presetId: PresetId = DEFAULT_PRESET_ID;
  /** O que o usuário pediu. Teto de tudo: nenhuma malha sobe acima daqui. */
  private presetEscolhido: PresetId = DEFAULT_PRESET_ID;
  /** Onde a escada de pressão sustentada (CPU ou rede) parou. */
  private presetPorPressao: PresetId = DEFAULT_PRESET_ID;
  /**
   * O degrau que o orçamento de upload PAGA, com bits por pixel honestos.
   * `null` quando a banda não é restrição.
   *
   * Esta é a fonte que faltava. O governador sempre soube o quanto o link
   * aguenta e sempre aplicou isso como `maxBitrate` — mas nada traduzia o
   * número em PIXEL, e apertar bits sem tirar pixel é a definição de QP alto.
   */
  private presetPorBanda: PresetId | null = null;
  /** Amostras seguidas sem aperto nenhum. */
  private calmaria = 0;
  /** Amostras seguidas com o encoder entregando zero frame, havendo plateia. */
  private semImagem = 0;
  /** Grava a estimativa de banda de vez em quando, não a cada segundo. */
  private desdeGravacao = 0;
  private pressure = 0;
  private pressureKind: QualityLimitation = 'none';
  private capturaOciosa = false;
  /** O que este transmissor consegue servir. O teto efetivo é o mínimo entre isto e o do servidor. */
  private readonly capacidade: number;
  /** Palpite até o servidor dizer o dele, no `hosting`. Nunca um número solto. */
  private maxPeers: number;
  /** O teto pela banda em vigor (ADR 0030). Ver `ajustarPorta`. */
  private vagasPelaBanda: number = CAPACIDADE_ATE_MEDIR;
  /** Sobrevive ao ciclo da transmissão: quem escolheu 40% quer 40% de novo. */
  private volumeTransmissao = 1;

  /**
   * Toda etapa assíncrona do `start()` carrega o epoch em que começou.
   * `stop()` e `fail()` incrementam.
   *
   * Sem isso, parar durante o `connecting` era desfeito: a negociação chegava
   * depois, o código seguia publicando e a sessão voltava para `live` com as
   * trilhas já paradas.
   */
  private epoch = 0;
  /** Governador, evidência de colapso e sonda de subida. Ver `malha-de-banda.ts`. */
  private readonly malha = new MalhaDeBanda();
  /** A série temporal do lado de quem transmite. Ver `core/media/diagnostico.ts`. */
  private readonly diario = new Diario('transmissor');
  private amostras = 0;
  private ociosoDesde: number | null = null;
  private surface: CaptureSurface = 'desconhecido';
  private preview: MediaStream | null = null;
  private prioridade: Prioridade = 'fluidez';

  constructor(private readonly deps: BroadcastSessionDeps) {
    // Nunca um número solto: `3` aqui sobrevivia até o `hosting` responder, e
    // nesse meio-tempo o HUD e as vagas desenhavam três de um canal que aceita
    // cinco — contradizendo o texto da própria Home, que lê `P2P_LIMITS`.
    this.capacidade = deps.capacidade ?? P2P_LIMITS.maxViewersSemUmEncode;
    this.maxPeers = this.capacidade;
  }

  getState(): BroadcastState {
    return this.state;
  }

  /** Nada sai da máquina sozinho: a UI copia, a pessoa decide se manda. */
  diagnostico(navegador: string): Diagnostico | null {
    return this.diario.vazio ? null : this.diario.relatorio(navegador);
  }

  subscribe(listener: () => void): () => void {
    return this.emitter.on('state', listener);
  }

  on<K extends keyof BroadcastEvents>(
    event: K,
    handler: (payload: BroadcastEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  private setState(next: BroadcastState): void {
    if (next.status !== this.state.status) {
      const agora = this.deps.scheduler.now();
      switch (next.status) {
        case 'requesting-capture':
          this.diario.evento('capture', 'START', agora);
          break;
        case 'connecting':
          this.diario.evento('signaling', 'CONNECTING', agora);
          break;
        case 'live':
          this.diario.evento('session', 'LIVE', agora);
          break;
        case 'ended':
          this.diario.evento(
            next.reason.startsWith('CAPTURE_') ? 'capture' : 'session',
            next.reason,
            agora,
          );
          break;
        case 'idle':
          break;
      }
    }
    this.state = next;
    this.emitter.emit('state', next);
  }

  private stale(epoch: number): boolean {
    return this.epoch !== epoch;
  }

  async start(
    slug: string,
    ownerToken: string,
    options: { audioDeviceId?: string; presetId?: PresetId; prioridade?: Prioridade } = {},
  ): Promise<void> {
    if (this.state.status !== 'idle' && this.state.status !== 'ended') return;

    this.epoch += 1;
    const epoch = this.epoch;
    const novoId = this.deps.diagnosticId ?? idLocal;
    this.diario.iniciar(novoId(), this.deps.appVersion ?? null);
    this.diario.tentativa(novoId(), this.deps.scheduler.now());

    this.presetId = options.presetId ?? DEFAULT_PRESET_ID;
    this.presetEscolhido = this.presetId;
    this.presetPorPressao = this.presetId;
    this.presetPorBanda = null;
    this.causaPressao = null;

    /**
     * Começa já sabendo o que o link deu da última vez.
     *
     * Sem isto, o aquecimento do governador deixa os primeiros oito segundos
     * de TODA transmissão sem teto — e é exatamente quando os espectadores
     * que estavam esperando entram de uma vez e o controle de congestionamento
     * sobe procurando o limite do link, N vezes em paralelo.
     */
    this.pressure = 0;
    this.pressureKind = 'none';
    this.capturaOciosa = false;
    this.malha.reiniciar();
    this.amostras = 0;
    this.ociosoDesde = null;
    /*
      A prioridade pode vir escolhida de antes do ar ("30 FPS" no passo 02).
      É o pacote inteiro da ADR 0015 — `detail` + `maintain-resolution` +
      30 fps —, nunca só o framerate: pela R5, 30 fps sozinho não alivia nada.
    */
    this.prioridade = options.prioridade ?? 'fluidez';
    this.pedidos.clear();
    this.quem.clear();
    // Estado que sobrevivia entre transmissões e não devia.
    this.calmaria = 0;
    this.semImagem = 0;
    this.desdeGravacao = 0;

    /**
     * A semente vem DEPOIS do `reset()`.
     *
     * Estava antes, e o `reset()` quatro linhas abaixo a apagava — medido:
     * `seed(4 Mbps)` seguido de `reset()` deixa a estimativa em `null`, e a
     * sessão real passava os oito segundos de aquecimento sem teto nenhum.
     * Exatamente o buraco que a semente existe para fechar.
     */
    const lembrado = Number(this.deps.uplinkMemory?.read() ?? '');
    if (Number.isFinite(lembrado) && lembrado > 0) this.malha.semear(lembrado);
    this.setState({ status: 'requesting-capture' });

    /**
     * A captura pede a resolução ESCOLHIDA, não a efetiva.
     *
     * `scaleResolutionDownBy` reduz pixel dentro do encoder e é reversível;
     * a resolução da trilha é fixada uma vez pelo `getDisplayMedia` e não
     * volta. Capturar já degradado seria um teto permanente — a transmissão
     * nunca recuperaria a nitidez depois que a banda melhorasse.
     */
    const preset = presetById(this.presetEscolhido);

    if (!this.deps.screen.isSupported()) return this.fail('CAPTURE_UNSUPPORTED');

    const pedido = await this.deps.screen.request({
      width: preset.width,
      height: preset.height,
      frameRate: Math.min(preset.main.maxFramerate, FRAMERATE_POR_PRIORIDADE[this.prioridade]),
      systemAudio: true,
    });
    // Mesmo quando deu certo na segunda tentativa: o nome do erro da primeira
    // é a pista de qual pedido o navegador recusou.
    this.diario.registrarFalhaDaCaptura(this.deps.screen.ultimaFalha?.() ?? null);
    if (!pedido.ok) {
      if (this.stale(epoch)) return;
      return this.fail(FALHA_DE_CAPTURA[pedido.error]);
    }
    const capture = pedido.value;

    // O usuário pode ter desistido durante o picker do sistema.
    if (this.stale(epoch)) {
      capture.video.stop();
      capture.audio?.stop();
      return;
    }

    this.videoTrack = capture.video;
    this.audioTrack = capture.audio;
    this.surface = capture.surface;
    this.somComCall = capture.audio !== null && capture.surface === 'monitor';
    this.diario.evento('capture', 'CAPTURE_READY', this.deps.scheduler.now());

    // Só vídeo: incluir o áudio faria o preview tocar o som do jogo de volta
    // nos alto-falantes, criando eco para quem transmite.
    this.preview = this.deps.createStream([capture.video]);

    /**
     * A linha que decide se o produto presta.
     *
     * O default do Chrome para captura de tela é `detail`: ele preserva
     * nitidez sacrificando framerate, porque assume que você está mostrando um
     * documento. Gameplay a 15fps nítido é inútil.
     */
    this.videoTrack.contentHint = CONTENT_HINT_POR_PRIORIDADE[this.prioridade];

    // Linux: sem áudio do sistema no getDisplayMedia. O usuário escolheu um
    // monitor de sink virtual; capturamos com todo processamento de voz
    // desligado.
    if (this.audioTrack === null && options.audioDeviceId !== undefined) {
      try {
        this.audioTrack = await this.deps.audio.capture(options.audioDeviceId);
      } catch {
        this.audioTrack = null; // transmitir mudo é melhor que não transmitir
      }
      if (this.stale(epoch)) return this.abandon();
    }

    /**
     * Ganho no caminho de saída, aplicado UMA vez, aqui.
     *
     * Este é o ponto onde os dois caminhos de áudio convergem — o do Windows,
     * que vem junto com a tela, e o do Linux, que vem do sink virtual. Envolver
     * depois deste ponto significa que o controle de volume vale para os dois
     * sem que nenhum deles precise saber que ele existe.
     */
    this.audioFonte = this.audioTrack;
    this.origemAudio =
      this.audioTrack === null ? null : capture.audio !== null ? 'captura' : 'dispositivo';
    const tipoFonte: TipoFonteAudio =
      this.audioTrack === null
        ? 'nenhuma'
        : capture.audio !== null
          ? fonteDaSuperficie(capture.surface)
          : 'dispositivo';
    this.diario.registrarCapturaAudio(descreverCaptura(this.audioFonte, tipoFonte));
    if (this.audioFonte !== null) {
      const fonte = this.audioFonte;
      // Observado na hora, e não na próxima amostra: o fim da fonte é o
      // único estado do som que não volta sozinho.
      fonte.addEventListener('ended', () => this.onFonteAudioEncerrada(fonte));
    }
    if (this.audioTrack !== null) {
      this.unsubscribes.push(this.deps.gain.onEstado((estado) => this.onGrafoAudio(estado)));
      this.audioTrack = this.deps.gain.attach(this.audioTrack);
      this.grafoAudio = this.deps.gain.estado;
      // Antes de publicar: senão o primeiro segundo sai no volume cheio, que
      // é justamente o susto que o controle existe para evitar.
      this.deps.gain.set(this.volumeTransmissao);
    }

    // O usuário pode encerrar pelo controle nativo do browser, fora da nossa UI.
    this.videoTrack.addEventListener('ended', () => void this.stop('CAPTURE_ENDED'));

    this.setState({ status: 'connecting' });

    try {
      // O servidor é a autoridade sobre o teto; o palpite local só vale até
      // aqui. Mas nunca ACIMA do que esta máquina serve: um servidor antigo,
      // que ignora a capacidade declarada, não pode abrir 50 vagas num
      // transmissor que codifica uma vez por peer.
      const aberto = await this.deps.transport.host(slug, ownerToken, { capacidade: this.capacidade });
      if (Number.isFinite(aberto.maxPeers) && aberto.maxPeers > 0) {
        this.maxPeers = Math.min(aberto.maxPeers, this.capacidade);
      }
    } catch (error) {
      if (this.stale(epoch)) return this.abandon();
      return this.fail(failureFor(error));
    }
    if (this.stale(epoch)) return this.abandon();
    // A porta começa fechada no conservador e a medição abre (ADR 0030).
    this.vagasPelaBanda = Math.min(CAPACIDADE_ATE_MEDIR, this.maxPeers);
    this.deps.transport.atualizarCapacidade?.(this.vagasPelaBanda);

    this.unsubscribes.push(
      this.deps.transport.on('pedido', (pedido) => this.onPedido(pedido)),
      this.deps.transport.on('pedido-cancelado', ({ peerId }) => {
        if (this.pedidos.delete(peerId)) this.publicarPedidos();
      }),
      this.deps.transport.on('espectador', ({ peerId, nome, impressao }) => {
        this.quem.set(peerId, { nome, impressao });
        this.publicarPedidos();
      }),
      this.deps.transport.on('peers', (peers) => this.onPeers(peers)),
      this.deps.transport.on('signaling-lost', () => this.onSignalingLost()),
      this.deps.transport.on('signaling-restored', () => this.onSignalingRestored()),
      this.deps.transport.on('closed', () => void this.stop('TRANSPORT_FAILED')),
    );

    try {
      await this.deps.transport.publishVideo(this.videoTrack, preset);
      // Fora do padrão, os senders precisam saber antes do primeiro espectador.
      if (this.prioridade !== 'fluidez') await this.deps.transport.setPrioridade(this.prioridade);
      if (this.audioTrack !== null) await this.deps.transport.publishAudio(this.audioTrack);
    } catch {
      if (this.stale(epoch)) return this.abandon();
      return this.fail('TRANSPORT_FAILED');
    }
    if (this.stale(epoch)) return this.abandon();

    const shareUrl = this.deps.shareUrlFor(slug);
    this.setState({
      status: 'live',
      shareUrl,
      slug,
      presetId: this.presetId,
      presetEscolhido: this.presetEscolhido,
      presetForced: false,
      peers: [],
      pedidos: this.listaDePedidos(),
      nomes: this.listaDeNomes(),
      maxPeers: this.maxPeers,
      vagasPelaBanda: this.vagasPelaBanda,
      stats: null,
      hasAudio: this.audioTrack !== null,
      capturaSemImagem: false,
      motivoDegradacao: null,
      volumeAudio: this.volumeTransmissao,
      audio: this.audioTrack === null ? 'sem-fonte' : 'desconhecido',
      grafoAudio: this.grafoAudio,
      volumeAjustavel: this.deps.gain.ativo,
      semSinalizacao: false,
      preview: this.preview,
      prioridade: this.prioridade,
      audioPerdidoPelaEscolha:
        this.audioTrack === null &&
        this.surface !== 'monitor' &&
        this.surface !== 'desconhecido',
      somComCall: this.somComCall,
      pausa: null,
    });

    this.timers.push(
      this.deps.scheduler.every(this.deps.statsIntervalMs ?? STATS_INTERVAL_MS, () =>
        void this.sampleStats(),
      ),
    );
    this.emitter.emit('started', { shareUrl });
  }

  private async sampleStats(): Promise<void> {
    if (this.state.status !== 'live') return;

    /**
     * ANTES do early return, e é o ponto todo.
     *
     * A ociosidade só era avaliada dentro de `onPeers`, e a primeira
     * notificação apenas marca a hora — exige uma SEGUNDA, dez segundos
     * depois. Sem espectador nenhum não existe fonte para essa segunda:
     * `admit`/`drop`/`onStateChange` precisam de link, e o caminho periódico
     * desiste antes de anunciar quando não há relatório de peer.
     *
     * Resultado medido pela auditoria: 2 minutos ocioso, `applyConstraints`
     * chamado zero vez, captura presa em 1080p60 de graça na máquina que está
     * com o jogo aberto. Este relógio de 1s é a segunda notificação.
     */
    this.throttleIdleCapture(this.state.peers.length === 0);

    const stats = await this.deps.transport.getAggregateStats();
    // `null` sem espectador: nada a medir, mas a ociosidade acima já foi tratada.
    if (stats === null) return;
    if (this.state.status !== 'live') return;

    this.amostras += 1;
    const agora = this.deps.scheduler.now();
    const audio = this.classificadorAudio.observar({
      trilha:
        this.audioFonte === null
          ? 'ausente'
          : this.audioFonte.readyState === 'ended'
            ? 'encerrada'
            : 'viva',
      mudoIntencional: this.volumeTransmissao === 0,
      // Quem transmite não reproduz o próprio som; o que pode estar parado é
      // o PROCESSAMENTO, e para os amigos o efeito é o mesmo: silêncio.
      reproducaoBloqueada: this.grafoAudio === 'suspenso' || this.grafoAudio === 'interrompido',
      stats: stats.audio,
      agora,
    });
    if (audio !== this.state.audio) this.diario.evento('audio', CODIGO_AUDIO[audio], agora);
    this.setState({ ...this.state, stats, audio });
    this.diario.registrar(stats, agora);
    this.applyUplinkCeiling(stats);
    this.ajustarPorta(stats);
    this.trackPressure(stats.limitation);
    // O que a CAPTURA solta, não o que o encoder produz: o "um encode" reenvia
    // o último quadro quando ela para, e o encoder nunca chega a 0.
    this.trackCapturaMorta(stats.fpsDaCaptura ?? stats.fps);
    this.vigiarNitidez(stats.fps, stats.limitation);
    this.lembrarBanda();
  }

  /**
   * A malha de banda decide; a sessão aplica (TELA-026).
   *
   * Quanto o link paga, a evidência de colapso e a sonda de subida moram em
   * `malha-de-banda.ts`. Aqui fica só o que é da sessão: gravar o orçamento no
   * transporte e compor o degrau da banda com o do usuário e o da CPU.
   */
  private applyUplinkCeiling(stats: MediaStats): void {
    const decisao = this.malha.observar({
      stats,
      presetEfetivo: this.presetId,
      presetEscolhido: this.presetEscolhido,
      presetPorBanda: this.presetPorBanda,
      prioridade: this.prioridade,
      reservaAudio: this.reservaDeAudio(),
      amostra: this.amostras,
    });
    // `null` na maioria das leituras: a malha só fala quando a mudança
    // compensa reconfigurar o encoder.
    if (decisao === null) return;
    void this.deps.transport.setUplinkBudget(decisao.orcamentoVideo).catch(() => undefined);
    this.presetPorBanda = decisao.presetPorBanda;
    this.aplicarDegrau();
  }

  /**
   * A porta pela banda (ADR 0030): quantos espectadores o link paga agora.
   *
   * A malha faz todo mundo descer junto quando o upload não dá; esta parte
   * decide quando parar de deixar ENTRAR, para a sala não descer até onde não
   * há imagem. O número vai ao servidor, que recusa só quem ainda não entrou.
   * A conta é pura (`capacidade-pela-banda.ts`); aqui fica o que é da sessão:
   * o envio medido, o orçamento em vigor e a histerese contra o valor anterior.
   */
  private ajustarPorta(stats: MediaStats): void {
    const enviadoPorCaminho = stats.bitrateBps / Math.max(1, stats.paresMedidos);
    const vagas = capacidadePelaBanda({
      orcamento: this.malha.orcamento,
      enviadoPorCaminho,
      caminhos: stats.paresMedidos,
      encoderOcioso: encoderOcioso(enviadoPorCaminho, this.malha.orcamento),
      reservaAudio: this.reservaDeAudio(),
      prioridade: this.prioridade,
      capacidadeDaMaquina: this.maxPeers,
      atual: this.vagasPelaBanda,
    });
    if (vagas === this.vagasPelaBanda) return;
    this.vagasPelaBanda = vagas;
    this.deps.transport.atualizarCapacidade?.(vagas);
    if (this.state.status === 'live') this.setState({ ...this.state, vagasPelaBanda: vagas });
  }

  /**
   * O que o áudio ocupa em cada caminho, e sai do orçamento antes do vídeo
   * (TELA-017, §7.3: `soma(vídeo) + R ≤ total`).
   *
   * A estimativa do WebRTC é do CAMINHO — áudio e vídeo dividem o mesmo
   * cano —, e o orçamento inteiro ia para o `maxBitrate` do vídeo. Com som,
   * o vídeo sempre pedia 128 kbps a mais do que cabia. O teto do Opus mais
   * ~10% de cabeçalhos RTP/SRTP/UDP a 50 pacotes por segundo.
   */
  private reservaDeAudio(): number {
    return this.audioTrack === null ? 0 : RESERVA_AUDIO_BPS;
  }

  /**
   * Recalcula o degrau efetivo a partir das três pressões e aplica se mudou.
   *
   * Nenhuma delas manda sozinha: o usuário põe o teto, a escada de pressão diz
   * o que a máquina sustenta e o orçamento diz o que o link paga. Vale a que
   * aperta mais. Antes as três escreviam no mesmo campo e a última apagava as
   * outras — a origem do defeito da ADR 0015.
   */
  private aplicarDegrau(): void {
    let alvo = menorPreset(this.presetEscolhido, this.presetPorPressao);
    if (this.presetPorBanda !== null) alvo = menorPreset(alvo, this.presetPorBanda);

    if (alvo === this.presetId) {
      this.sincronizarMotivo(alvo);
      return;
    }
    this.presetId = alvo;

    if (this.state.status === 'live') {
      this.setState({
        ...this.state,
        presetId: alvo,
        presetForced: alvo !== this.presetEscolhido,
        motivoDegradacao: this.motivoAtual(alvo),
      });
    }
    // `catch` obrigatório: fire-and-forget aqui já produziu unhandled
    // rejection quando colidiu com uma troca manual de qualidade.
    void this.deps.transport.setPreset(presetById(alvo)).catch(() => undefined);
  }

  /**
   * POR QUE o degrau está abaixo do escolhido, para a tela não mandar a pessoa
   * procurar no lugar errado.
   *
   * A banda vem primeiro quando é ela que amarra: mexer na máquina não
   * conserta link, e `cpu` é o único caso em que o usuário tem o que fazer.
   */
  private motivoAtual(efetivo: PresetId): QualityLimitation | null {
    if (efetivo === this.presetEscolhido) return null;
    // A banda vem primeiro quando é ela que amarra: mexer na máquina não
    // conserta link, e `cpu` é o único caso em que o usuário tem o que fazer.
    if (this.presetPorBanda === efetivo) return 'bandwidth';
    return this.causaPressao ?? 'bandwidth';
  }

  /** Por que a escada de pressão desceu. Sobrevive ao fim do aperto. */
  private causaPressao: QualityLimitation | null = null;

  /** O degrau não mudou, mas a CAUSA pode ter mudado — e a tela precisa saber. */
  private sincronizarMotivo(efetivo: PresetId): void {
    if (this.state.status !== 'live') return;
    const motivo = this.motivoAtual(efetivo);
    if (motivo === this.state.motivoDegradacao) return;
    this.setState({ ...this.state, motivoDegradacao: motivo });
  }

  /**
   * Degradação automática por CPU.
   *
   * Uma leitura isolada com `cpu` acontece em qualquer keyframe. Só uma
   * sequência sustentada significa encode em software, e aí o único remédio é
   * codificar menos pixel — devolvendo CPU para o jogo.
   */
  /**
   * Degradação automática, por CPU **ou por banda**.
   *
   * A versão anterior só olhava `cpu` e ignorava `bandwidth` — o WebRTC dizia
   * em letras garrafais "estou limitado pela rede" e o produto não fazia nada,
   * continuava pedindo 8 Mbps de um link que não tinha. Era o caminho direto
   * para o ping do jogo subir.
   */
  private trackPressure(limitation: QualityLimitation): void {
    // Aquecimento: no começo tudo parece apertado, e passa sozinho.
    if (this.amostras <= AQUECIMENTO_AMOSTRAS) return;

    if (limitation !== 'cpu' && limitation !== 'bandwidth') {
      this.pressure = 0;
      this.pressureKind = 'none';
      this.recuperar();
      return;
    }
    /**
     * Banda é trabalho do GOVERNADOR, quando ele tem o que medir.
     *
     * Esta escada e o teto de upload passaram a olhar para a mesma coisa, e
     * duas malhas reagindo à mesma pressão contam em dobro: o orçamento já
     * derrubou o degrau para 480p60, o Chromium continua reportando
     * `bandwidth` — porque É banda —, e cinco leituras depois esta escada
     * derrubava de novo para 360p60. É a mesma composição de adaptações que a
     * ADR 0015 existe para desfazer, só que entre malhas nossas.
     *
     * Pior no retorno: `presetPorPressao` ficava marcado lá embaixo, e quando
     * a banda voltava a escada levava sessenta amostras POR DEGRAU para
     * desfazer uma queda que nunca foi dela.
     *
     * O ramo continua vivo para o navegador que não reporta
     * `availableOutgoingBitrate`: ali o governador não tem estimativa, não
     * aplica teto nenhum, e esta escada é a única defesa que sobra.
     */
    if (limitation === 'bandwidth' && this.malha.estimativa !== null) {
      this.pressure = 0;
      this.pressureKind = 'none';
      /**
       * E a recuperação SEGUE andando, o que a primeira versão desta guarda
       * esquecia.
       *
       * Retornar aqui congelava a calmaria: com o orçamento apertado e o
       * Chromium reportando `bandwidth` de forma contínua, `recuperar()` nunca
       * era chamado, e uma queda causada por um transiente de CPU ficava
       * marcada em `presetPorPressao` para sempre. O degrau efetivo continuava
       * abaixo do que o link pagava, sem que nada na tela explicasse por quê.
       *
       * Subir aqui é seguro por construção: `aplicarDegrau()` corta no
       * `presetPorBanda`, então a escada de pressão pode voltar ao topo sem
       * que um único bit a mais saia do link.
       */
      this.recuperar();
      return;
    }

    /**
     * A calmaria DECAI, não zera — e a diferença é de ordens de grandeza.
     *
     * Descer exige 5 amostras consecutivas; subir exigia 60 CONSECUTIVAS,
     * porque qualquer leitura de aperto zerava o contador. Um
     * `qualityLimitationReason: 'cpu'` isolado é rotina: keyframe, troca de
     * cena, alt-tab. Com 10% de leituras assim, o tempo médio para recuperar
     * UM degrau passa de 60 segundos para 92 minutos — e com 20%, nunca.
     *
     * O comentário do `recuperar()` diz "doze vezes mais lento que a descida".
     * Com ruído real a razão era de duas a três ordens de grandeza, porque
     * "5 seguidas" e "60 seguidas" sobre o mesmo processo ruidoso não são
     * comparáveis. Decaindo, um blip custa dez amostras em vez de todas.
     */
    this.calmaria = Math.max(0, this.calmaria - CALMARIA_PENALIDADE);
    if (limitation !== this.pressureKind) {
      this.pressureKind = limitation;
      this.pressure = 0;
    }
    this.pressure += 1;
    if (this.pressure < PRESSURE_SAMPLES) return;

    /**
     * Desce a partir do EFETIVO, não do valor próprio desta escada.
     *
     * Se a banda já puxou o degrau para 480p60 e a CPU continua apertando, o
     * próximo passo tem de ser 360p60 — não o degrau abaixo de onde a escada
     * de pressão estava parada, que poderia ser 900p60 e não aliviaria nada.
     */
    const next = nextPresetOnCpuPressure(this.presetId);
    this.pressure = 0;

    if (next === null) {
      /**
       * Fundo da escada: não há degrau para descer, mas a CAUSA mudou e a tela
       * precisa saber. Retornar aqui congelava a mensagem no motivo anterior —
       * o usuário lia "sua subida não comporta" enquanto o problema já era
       * encode pesado, e ia procurar no lugar errado.
       */
      if (this.state.status === 'live' && this.state.motivoDegradacao !== this.pressureKind) {
        this.setState({ ...this.state, motivoDegradacao: this.pressureKind });
      }
      return;
    }

    this.presetPorPressao = next;
    /**
     * A causa é gravada AQUI e sobrevive ao fim da pressão.
     *
     * `pressureKind` volta a `none` assim que o aperto passa, mas o degrau
     * continua baixo até a recuperação subir de volta. Ler `pressureKind`
     * nesse intervalo dizia "banda" para uma queda que foi de CPU — e mandava
     * a pessoa procurar no roteador um problema que estava no encoder.
     */
    this.causaPressao = this.pressureKind;
    this.aplicarDegrau();
  }

  /**
   * Guarda o que o link sustentou, para a próxima transmissão não começar cega.
   *
   * A cada 30 amostras e não a cada uma: é preferência, não telemetria, e
   * escrever em disco por segundo durante horas de jogo é custo sem retorno.
   */
  private lembrarBanda(): void {
    this.desdeGravacao += 1;
    if (this.desdeGravacao < GRAVAR_BANDA_A_CADA) return;
    this.desdeGravacao = 0;
    const estimativa = this.malha.estimativa;
    if (estimativa === null) return;
    this.deps.uplinkMemory?.write(String(Math.round(estimativa)));
  }

  /**
   * Captura viva que não entrega imagem.
   *
   * Acontece de verdade: em alguns caminhos de captura de tela inteira —
   * Wayland via portal — a trilha é criada e nunca produz frame. O navegador
   * não avisa, a transmissão sai preta e ninguém sabe por quê.
   *
   * A detecção mora AQUI, e não num elemento de vídeo escondido, por dois
   * motivos. O primeiro é custo: manter um `<video>` puxando frames na máquina
   * que está rodando o jogo é exatamente o tipo de trabalho que este produto
   * existe para não cobrar. O segundo é precisão: `framesPerSecond` do
   * `outbound-rtp` é o que de fato sai para os espectadores, então também pega
   * encoder travado, não só captura morta.
   *
   * Só vale com plateia: sem espectador não há `outbound-rtp`, e sem ninguém
   * do outro lado não há tela preta para ninguém ver.
   */
  /**
   * `nitidez` que virou apresentação de slides volta para `fluidez`.
   *
   * O E2E mediu o modo a 8 fps no fundo da escada: o encoder encosta no teto de
   * QP e só lhe resta descartar quadro. E `nitidez` põe o `contentHint` em
   * `detail`, que desliga o quality scaler do Chromium — a rede de segurança
   * que teria tirado resolução em vez de quadro. As duas coisas juntas fazem o
   * modo falhar exatamente onde ele mais promete.
   *
   * Voltar para `fluidez` religa o scaler. A imagem fica menor e volta a se
   * mexer, que é melhor que nítida e parada.
   */
  private vigiarNitidez(fps: number, limitacao: QualityLimitation): void {
    if (this.prioridade !== 'nitidez') {
      this.nitidezLenta = 0;
      return;
    }
    // Aquecimento e transientes: só uma sequência sustentada significa algo.
    if (this.amostras <= AQUECIMENTO_AMOSTRAS || fps <= 0) return;

    /**
     * Framerate baixo só conta quando há APERTO. Sem isso o modo se
     * autodestruía no conteúdo para o qual foi criado.
     *
     * `framesPerSecond` do `outbound-rtp` são quadros ENVIADOS, e captura de
     * tela é dirigida a mudança: um mapa, um inventário ou uma planilha
     * produzem poucos quadros por segundo com a máquina inteiramente folgada.
     * A guarda de `fps <= 0` não cobria a faixa de 1 a 19.
     *
     * O resultado era cruel e circular: a pessoa escolhia `nitidez` para
     * mostrar o mapa, mexia o mouse de vez em quando, e cinco segundos depois
     * o produto voltava para `fluidez` e borrava o mapa. Reescolher `nitidez`
     * era revertido de novo em cinco segundos.
     *
     * O que justifica desistir é o encoder NÃO DAR CONTA — e isso o
     * `qualityLimitationReason` diz. Cena parada reporta `none`.
     */
    if (limitacao === 'none') {
      this.nitidezLenta = 0;
      return;
    }

    this.nitidezLenta = fps < NITIDEZ_FPS_MINIMO ? this.nitidezLenta + 1 : 0;
    if (this.nitidezLenta < PRESSURE_SAMPLES) return;

    this.nitidezLenta = 0;
    // `catch` obrigatório: `setPrioridade` faz `setParameters`, que rejeita se
    // um sender fechou no meio — a mesma unhandled rejection que
    // `aplicarDegrau` documenta ter produzido.
    void this.setPrioridade('fluidez').catch(() => undefined);
  }

  /** Amostras seguidas em que `nitidez` não entregou framerate de vídeo. */
  private nitidezLenta = 0;


  private trackCapturaMorta(fps: number): void {
    if (this.state.status !== 'live') return;
    // O quadro neutro anda a 2 fps de propósito: não é captura morta.
    if (this.pausa !== null) {
      this.semImagem = 0;
      return;
    }

    const relevante = this.state.peers.length > 0 && this.amostras > AQUECIMENTO_AMOSTRAS;
    this.semImagem = relevante && fps === 0 ? this.semImagem + 1 : 0;

    const morta = this.semImagem >= SEM_IMAGEM_AMOSTRAS;
    if (morta === this.state.capturaSemImagem) return;
    this.setState({ ...this.state, capturaSemImagem: morta });
  }

  /**
   * Devolve um degrau quando o aperto passou, devagar.
   *
   * A assimetria é o ponto: desce em 5 amostras, sobe em 60. Descer rápido
   * protege a transmissão; subir rápido faria a escada oscilar em volta do
   * ponto de aperto, e uma malha que reage mais rápido do que o sistema
   * assenta oscila, sempre.
   */
  private recuperar(): void {
    if (this.presetPorPressao === this.presetEscolhido) {
      this.calmaria = 0;
      return;
    }

    /**
     * A trava do teto de upload SAIU daqui, e a remoção é metade do conserto.
     *
     * Ela dizia: teto em vigor significa que a banda não sobra, então subir
     * seria cair de novo em segundos. O raciocínio estava certo para o modelo
     * antigo, onde subir de degrau significava pedir mais bits. Só que a trava
     * era permanente na prática — o teto quase nunca largava, e uma vez
     * degradado por um transiente de CPU o usuário ficava no degrau baixo pelo
     * resto da sessão. É o "embaçou e não voltou" dos relatos.
     *
     * Com o orçamento virando `presetPorBanda`, o piso de banda continua
     * valendo por construção: esta escada sobe, e `aplicarDegrau()` corta no
     * que o link paga. Nunca se pede mais do que o teto dá, e nunca se fica
     * preso embaixo quando a CPU já se resolveu.
     */
    this.calmaria += 1;
    if (this.calmaria < CALMARIA_AMOSTRAS) return;
    this.calmaria = 0;

    const acima = previousPresetOnRecovery(this.presetPorPressao, this.presetEscolhido);
    if (acima === null) return;

    this.presetPorPressao = acima;
    if (acima === this.presetEscolhido) this.causaPressao = null;
    this.aplicarDegrau();
  }

  /**
   * Escolhe o que ceder quando os bits não dão para tudo.
   *
   * `fluidez` segura os 60fps e deixa borrar — certo para gameplay, onde o
   * movimento é a informação. `nitidez` segura a resolução e deixa o
   * framerate cair — certo quando o DETALHE é a informação, como um mapa ou
   * texto na tela.
   *
   * Não renegocia: é `setParameters` nos senders, ninguém pisca.
   */
  /**
   * Volume do que sai para os espectadores.
   *
   * Síncrono e sem renegociação: mexe num `GainNode` no caminho do áudio, não
   * nos parâmetros do sender. Arrastar a barra não custa nada à transmissão.
   */
  /**
   * Tira todo mundo que está assistindo, e esquece quem foi aceito: quem
   * voltar pelo link pede de novo, e o dono decide de novo.
   */
  desconectarTodos(): void {
    if (this.state.status !== 'live') return;
    // Tirar todo mundo desfaz as aprovações: quem voltar pelo link pede de novo.
    this.aprovados.limpar();
    this.deps.transport.removeViewers();
  }

  /**
   * Tira UM espectador (C-08). Quem foi tirado deixa de estar aprovado neste
   * aparelho: se voltar pelo link, pede de novo, como no "desconectar todos".
   * Os outros seguem assistindo.
   */
  removerEspectador(peerId: string): void {
    if (this.state.status !== 'live') return;
    const quem = this.quem.get(peerId);
    if (quem !== undefined) this.aprovados.revogar(quem.impressao);
    this.deps.transport.removeViewers(peerId);
  }

  /* ─────────────── aprovação manual (ADR 0025) ─────────────── */

  private get aprovados(): Aprovados {
    return (this.aprovadosPadrao ??= this.deps.aprovados ?? aprovadosEmMemoria());
  }
  private aprovadosPadrao: Aprovados | null = null;

  /** Pedidos esperando resposta, por `peerId`. Map guarda a ordem de chegada. */
  private readonly pedidos = new Map<string, { nome: string; impressao: string; desde: number }>();
  /** Quem já entrou: apelido e impressão, por `peerId`. */
  private readonly quem = new Map<string, { nome: string; impressao: string }>();

  private onPedido(pedido: { peerId: string; nome: string; impressao: string }): void {
    const agora = this.deps.scheduler.now();
    /*
      Já aceito neste aparelho: entra sem perguntar. É o que faz uma queda de
      rede, um F5 do amigo ou a transmissão de amanhã não virarem pedido novo.
    */
    if (this.aprovados.tem(pedido.impressao)) {
      this.diario.evento('session', 'JOIN_APPROVED', agora);
      this.deps.transport.responderPedido(pedido.peerId, true);
      return;
    }
    // Reapresentado depois de reconectar: mantém a hora original.
    const anterior = this.pedidos.get(pedido.peerId);
    this.pedidos.set(pedido.peerId, {
      nome: pedido.nome, impressao: pedido.impressao, desde: anterior?.desde ?? agora,
    });
    if (anterior === undefined) this.diario.evento('session', 'JOIN_REQUESTED', agora);
    this.publicarPedidos();
  }

  /** Aceita e lembra: a mesma pessoa não pede de novo até o dono desconectar todos. */
  aceitarPedido(peerId: string): void {
    const pedido = this.pedidos.get(peerId);
    if (pedido === undefined) return;
    this.pedidos.delete(peerId);
    this.aprovados.aprovar(pedido.impressao);
    this.diario.evento('session', 'JOIN_APPROVED', this.deps.scheduler.now());
    this.deps.transport.responderPedido(peerId, true);
    this.publicarPedidos();
  }

  /** Recusa só este pedido. Não é bloqueio: a pessoa pode pedir de novo. */
  recusarPedido(peerId: string): void {
    if (!this.pedidos.delete(peerId)) return;
    this.diario.evento('session', 'JOIN_REFUSED', this.deps.scheduler.now());
    this.deps.transport.responderPedido(peerId, false);
    this.publicarPedidos();
  }

  private listaDePedidos(): readonly PedidoPendente[] {
    return [...this.pedidos].map(([peerId, p]) => ({ peerId, nome: p.nome, desde: p.desde }));
  }

  private listaDeNomes(): Readonly<Record<string, string>> {
    return Object.fromEntries([...this.quem].map(([peerId, q]) => [peerId, q.nome]));
  }

  private publicarPedidos(): void {
    if (this.state.status !== 'live') return;
    this.setState({ ...this.state, pedidos: this.listaDePedidos(), nomes: this.listaDeNomes() });
  }

  /** Pausa em curso. Espelha `state.pausa`, e sobrevive a trocas de estado. */
  private pausa: { readonly comSom: boolean; readonly quadro: MediaStreamTrack | null } | null = null;
  /** Ver `somComCall` no estado. */
  private somComCall = false;

  /**
   * Oculta a transmissão sem perder a sala (TELA-022, §10.3).
   *
   * O vídeo vira o quadro neutro por `replaceTrack` — sem renegociar, sem
   * congelar o último conteúdo. O som para por padrão; manter é escolha
   * explícita. A captura continua viva: "pausar" não é "encerrar", e retomar
   * não pede o seletor de novo. O que já saiu antes do clique não volta —
   * pacote enviado não se recolhe.
   */
  async pausar(opcoes: { readonly manterSom?: boolean } = {}): Promise<void> {
    if (this.state.status !== 'live' || this.pausa !== null) return;
    const comSom = opcoes.manterSom === true;
    const quadro = this.deps.quadroNeutro?.abrir() ?? null;
    this.pausa = { comSom, quadro };
    if (quadro !== null) {
      await this.deps.transport.replaceVideo(quadro);
    } else if (this.videoTrack !== null) {
      this.videoTrack.enabled = false;
    }
    if (!comSom && this.audioTrack !== null) this.audioTrack.enabled = false;
    this.diario.evento('session', 'PRIVACY_PAUSED', this.deps.scheduler.now());
    if (this.state.status === 'live') this.setState({ ...this.state, pausa: { comSom } });
  }

  async retomar(): Promise<void> {
    const pausa = this.pausa;
    if (pausa === null) return;
    this.pausa = null;
    if (this.videoTrack !== null) {
      this.videoTrack.enabled = true;
      // Sempre: se a fonte foi trocada durante a pausa, o sender ainda está
      // com o quadro neutro — ou com a trilha antiga, já parada.
      await this.deps.transport.replaceVideo(this.videoTrack);
    }
    this.deps.quadroNeutro?.fechar();
    if (this.audioTrack !== null) this.audioTrack.enabled = true;
    this.diario.evento('session', 'PRIVACY_RESUMED', this.deps.scheduler.now());
    if (this.state.status === 'live') this.setState({ ...this.state, pausa: null });
  }

  /**
   * O áudio numa troca de tela (TELA-012, §6.8).
   *
   * Antes, a trilha de áudio da captura nova era sempre parada e a sessão
   * seguia com a da antiga. Certo para o monitor do sink virtual, que não
   * tem nada a ver com a tela; errado para o som que VEIO com a tela: trocar
   * da aba do jogo para a do navegador continuava mandando o som do jogo — ou,
   * pior, o de uma aba que a pessoa deixou de compartilhar.
   *
   * Três casos:
   * - som de dispositivo: fica; o da captura nova é descartado (e parado — a
   *   sessão não pode deixar captura de som viva sem uso);
   * - som da captura, e a nova tem som: ganho religado na trilha nova e
   *   `replaceTrack` nos senders, sem renegociar;
   * - som da captura, e a nova NÃO tem: para de mandar som. Não se inventa
   *   continuidade.
   */
  private async trocarAudioJunto(novo: MediaStreamTrack | null, surface: CaptureSurface): Promise<void> {
    if (this.origemAudio === 'dispositivo') {
      novo?.stop();
      return;
    }
    const agora = this.deps.scheduler.now();
    if (novo !== null) {
      this.audioFonte = novo;
      novo.addEventListener('ended', () => this.onFonteAudioEncerrada(novo));
      // `attach` desmonta o grafo antigo e para a trilha crua dele.
      this.audioTrack = this.deps.gain.attach(novo);
      this.deps.gain.set(this.volumeTransmissao);
      // Trocar a tela na pausa sem som não pode religar o som.
      if (this.pausa !== null && !this.pausa.comSom) this.audioTrack.enabled = false;
      this.origemAudio = 'captura';
      this.somComCall = surface === 'monitor';
      this.classificadorAudio.reiniciar();
      this.diario.registrarCapturaAudio(descreverCaptura(novo, fonteDaSuperficie(surface)));
      this.diario.evento('audio', 'AUDIO_SOURCE_SWITCHED', agora);
      await this.deps.transport.replaceAudio(this.audioTrack);
      return;
    }
    if (this.origemAudio === 'captura') {
      this.somComCall = false;
      await this.deps.transport.replaceAudio(null);
      this.deps.gain.close();
      this.audioTrack = null;
      this.audioFonte = null;
      this.origemAudio = null;
      this.diario.evento('audio', 'AUDIO_NONE', agora);
    }
  }

  /**
   * Retoma o grafo de áudio suspenso. Só funciona dentro de um GESTO: é o
   * botão "ativar áudio da transmissão" que chama isto.
   */
  async retomarAudio(): Promise<void> {
    const estado = await this.deps.gain.retomar();
    this.onGrafoAudio(estado);
  }

  private onGrafoAudio(estado: EstadoGrafo): void {
    if (estado === this.grafoAudio) return;
    this.grafoAudio = estado;
    this.diario.evento('audio', CODIGO_GRAFO[estado], this.deps.scheduler.now());
    if (this.state.status === 'live') this.setState({ ...this.state, grafoAudio: estado });
  }

  private onFonteAudioEncerrada(fonte: MediaStreamTrack): void {
    if (fonte !== this.audioFonte) return;
    const agora = this.deps.scheduler.now();
    this.diario.evento('audio', 'AUDIO_SOURCE_ENDED', agora);
    if (this.state.status !== 'live' || this.state.audio === 'encerrada') return;
    this.diario.evento('audio', CODIGO_AUDIO.encerrada, agora);
    this.setState({ ...this.state, audio: 'encerrada' });
  }

  setVolumeTransmissao(volume: number): void {
    const limitado = Math.min(1, Math.max(0, volume));
    this.volumeTransmissao = limitado;
    this.deps.gain.set(limitado);
    if (this.state.status === 'live') {
      this.setState({ ...this.state, volumeAudio: limitado });
    }
  }

  async setPrioridade(prioridade: Prioridade): Promise<void> {
    if (this.prioridade === prioridade) return;
    this.prioridade = prioridade;

    /**
     * O `contentHint` acompanha, e é a metade do controle que faltava.
     *
     * Ele troca o CAMINHO de codificação no Chromium: `motion` liga o quality
     * scaler, que derruba resolução para segurar quadro; `detail` liga o modo
     * de conteúdo de tela, que segura resolução e derruba quadro. Sem mexer
     * nisto, `nitidez` pedia ao encoder para preservar uma resolução pelo
     * `degradationPreference` enquanto o caminho que de fato decide isso
     * continuava configurado para o oposto.
     *
     * A R5 trava `motion` como PADRÃO, e ele continua sendo o padrão. Isto é
     * uma escolha explícita do usuário — a mesma que a ADR 0009 abriu.
     */
    const track = this.videoTrack;
    if (track !== null) track.contentHint = CONTENT_HINT_POR_PRIORIDADE[prioridade];

    if (this.state.status === 'live') this.setState({ ...this.state, prioridade });

    /**
     * O degrau é recalculado ANTES de a topologia trocar o framerate, e a
     * ordem custou uma janela de 0,054 bpp.
     *
     * `setPrioridade` no transporte muda o `maxFramerate` de 30 para 60 na
     * hora. Se o degrau ainda for o que foi escolhido PARA 30fps, o encoder
     * passa um round-trip inteiro de `setParameters` — com keyframe — rodando
     * o dobro de quadros no mesmo orçamento. Medido: 3 Mbps em 1280×720, de
     * 0,109 bpp para 0,054, metade do piso.
     *
     * A 30fps o mesmo orçamento paga o DOBRO de bits por pixel, então cabe uma
     * resolução maior. É assim que `nitidez` entrega 1280×720@30 onde
     * `fluidez` entrega 854×480@60 — pelos mesmos bits, sem pedir um a mais.
     */
    const orcamento = this.malha.orcamento;
    this.presetPorBanda =
      orcamento === null ? null : presetParaOrcamento(orcamento, prioridade);
    this.aplicarDegrau();

    await this.deps.transport.setPrioridade(prioridade);
  }

  /**
   * Troca o que está sendo transmitido, sem derrubar ninguém.
   *
   * Abre o seletor de novo e substitui a trilha nos senders já negociados.
   * Quem está assistindo não pisca: o SDP não muda. É o que permite alternar
   * entre tela inteira e uma janela específica no meio da transmissão, que é
   * como as pessoas de fato usam — mostram o jogo, depois o navegador,
   * depois o jogo de novo.
   */
  async switchSource(): Promise<void> {
    if (this.state.status !== 'live') return;
    const epoch = this.epoch;
    // Na resolução ESCOLHIDA, como no `start()`: capturar já degradado seria
    // um teto permanente, porque a resolução da trilha não volta a subir.
    const preset = presetById(this.presetEscolhido);

    const pedido = await this.deps.screen.request({
      width: preset.width,
      height: preset.height,
      frameRate: Math.min(preset.main.maxFramerate, FRAMERATE_POR_PRIORIDADE[this.prioridade]),
      systemAudio: true,
    });
    // Cancelar o seletor — ou ele falhar — é desistir da troca, não da
    // transmissão: a fonte antiga continua no ar.
    if (!pedido.ok) return;
    const capture = pedido.value;
    if (this.stale(epoch)) {
      capture.video.stop();
      capture.audio?.stop();
      return;
    }

    const anterior = this.videoTrack;
    // Da prioridade CORRENTE, não a constante: trocar de tela em modo
    // `nitidez` reinstalava `motion` e desfazia a escolha em silêncio.
    capture.video.contentHint = CONTENT_HINT_POR_PRIORIDADE[this.prioridade];
    capture.video.addEventListener('ended', () => void this.stop('CAPTURE_ENDED'));

    this.videoTrack = capture.video;
    this.surface = capture.surface;
    this.preview = this.deps.createStream([capture.video]);

    // Na pausa, a tela nova fica guardada: trocar de fonte não pode vazar
    // imagem para quem está vendo o quadro neutro.
    if (this.pausa === null) await this.deps.transport.replaceVideo(capture.video);

    await this.trocarAudioJunto(capture.audio, capture.surface);

    // Só depois de a nova estar no ar: parar antes deixaria um buraco visível.
    anterior?.stop();

    /**
     * A trilha nova nasce a 60fps, então o throttle de ociosidade precisa
     * saber que ele não está mais em vigor.
     *
     * `capturaOciosa` continuava `true` depois da troca, e
     * `throttleIdleCapture` tem um `if (this.capturaOciosa) return` que
     * bloqueava a reaplicação. Quem abria a transmissão, esperava dez segundos
     * sozinho (captura cai para 5fps) e então trocava a fonte para o jogo
     * ficava com 1920×1080@60 permanente sem ninguém assistindo — exatamente o
     * custo que o modo ocioso existe para devolver.
     */
    this.capturaOciosa = false;
    this.ociosoDesde = null;
    this.throttleIdleCapture(this.state.peers.length === 0);

    if (this.state.status !== 'live') return;
    this.setState({
      ...this.state,
      preview: this.preview,
      hasAudio: this.audioTrack !== null,
      ...(this.audioTrack === null ? { audio: 'sem-fonte' as const } : {}),
      audioPerdidoPelaEscolha:
        this.audioTrack === null &&
        this.surface !== 'monitor' &&
        this.surface !== 'desconhecido',
      somComCall: this.somComCall,
    });
  }

  /**
   * Troca de qualidade escolhida pelo usuário, com a transmissão no ar.
   *
   * Em mesh isso é `setParameters` nos senders existentes: nenhuma
   * renegociação, ninguém pisca. Escolher manualmente limpa a marca de
   * "forçado pela CPU" — se o usuário insiste em 1080p com o encoder no
   * limite, o produto avisa, mas obedece.
   */
  async setPreset(next: PresetId): Promise<void> {
    if (this.state.status !== 'live') {
      this.presetId = next;
      return;
    }
    // Compara com a ESCOLHA, não com o que está no ar: com a rede segurando
    // 720p, escolher 720p é uma decisão nova (baixar o teto), não um no-op.
    if (next === this.presetEscolhido) return;

    // Escolha manual redefine o teto de tudo: é a nova intenção do usuário.
    this.presetEscolhido = next;
    this.presetPorPressao = next;
    this.causaPressao = null;
    this.pressure = 0;
    this.pressureKind = 'none';
    this.calmaria = 0;

    /**
     * O orçamento de banda NÃO é zerado junto.
     *
     * Se o link paga 3 Mbps, ele continua pagando 3 Mbps depois do clique.
     * Fingir o contrário devolveria exatamente a imagem borrada que a ADR 0015
     * corrige — o produto obedeceria o rótulo e mentiria sobre a imagem. O que
     * a escolha manual faz é recalcular o degrau que aquele orçamento paga sob
     * a nova intenção, e a UI mostra `presetForced` quando os dois divergem.
     */
    const orcamento = this.malha.orcamento;
    this.presetPorBanda =
      orcamento === null ? null : presetParaOrcamento(orcamento, this.prioridade);

    /**
     * NADA de `transport.setPreset(next)` cru aqui.
     *
     * A ordem antiga mandava o preset do usuário ao transporte e só depois
     * recortava no orçamento. Com 3 Mbps medidos e um clique em 1080p60, os
     * senders recebiam de verdade `scaleResolutionDownBy: 1` a 3 Mbps — 0,024
     * bit por pixel, o número exato da foto que motivou a ADR 0015,
     * reintroduzido por ordem de operações. Um round-trip depois vinha a
     * correção: duas reconfigurações de encoder e dois keyframes por clique,
     * uma delas na densidade que produz o quadriculado.
     *
     * `aplicarDegrau()` já manda ao transporte o degrau efetivo, uma vez só.
     */
    this.aplicarDegrau();
    if (this.state.status === 'live') {
      this.setState({
        ...this.state,
        presetEscolhido: next,
        presetForced: this.presetId !== next,
        motivoDegradacao: this.motivoAtual(this.presetId),
      });
    }

    /**
     * E a CAPTURA acompanha a escolha — era a metade que faltava.
     *
     * A resolução da trilha é fixada no `getDisplayMedia` e só muda por
     * `applyConstraints`. Sem isto, quem começava em 720p e subia para 1080p ao
     * vivo via o rótulo mudar e a imagem ficar em 1280×720: o encoder só tira
     * pixel (`scaleResolutionDownBy ≥ 1`), não cria. Descer também passa por
     * aqui, para a captura não ficar pagando 1080p que ninguém vai ver.
     */
    this.aplicarCaptura(this.fpsDaCaptura(), this.capturaOciosa);
  }

  /**
   * A transmissão CONTINUA sem o servidor de sinalização.
   *
   * Antes isso chamava `stop()` e matava tudo em menos de dois segundos —
   * exatamente o oposto do que a arquitetura promete. Agora o produto só
   * avisa que ninguém novo consegue entrar, e quem está assistindo continua.
   */
  private onSignalingLost(): void {
    if (this.state.status !== 'live') return;
    if (this.state.semSinalizacao) return;
    this.setState({ ...this.state, semSinalizacao: true });
  }

  /**
   * O canal voltou. O aviso tem que sumir.
   *
   * `semSinalizacao` era porta de mão única: entrava em `true` e não havia
   * caminho de volta, então um restart de dois segundos do servidor deixava o
   * transmissor marcado como "fora do ar" pelo resto da sessão — mesmo com o
   * canal já reaberto e aceitando espectadores.
   */
  private onSignalingRestored(): void {
    if (this.state.status !== 'live') return;
    // O servidor que reabriu começa sem teto pela banda: manda de novo.
    this.deps.transport.atualizarCapacidade?.(this.vagasPelaBanda);
    if (!this.state.semSinalizacao) return;
    this.setState({ ...this.state, semSinalizacao: false });
  }

  private onPeers(peers: readonly PeerInfo[]): void {
    this.throttleIdleCapture(peers.length === 0);
    if (this.state.status !== 'live') return;
    this.setState({ ...this.state, peers });
  }

  /**
   * Com zero espectadores, captura a 5fps.
   *
   * Não há encoder rodando sem peer — mas a captura de tela continua, e a
   * 1080p60 ela custa GPU e compositor numa máquina que está rodando um jogo.
   * Ninguém está do outro lado para ver a diferença.
   */
  private throttleIdleCapture(ocioso: boolean): void {
    const agora = this.deps.scheduler.now();

    if (!ocioso) {
      this.ociosoDesde = null;
      if (this.capturaOciosa) this.aplicarCaptura(this.fpsDaCaptura(false), false);
      return;
    }

    // Ficou ocioso agora: marca a hora e espera. Um peer pode sumir por um
    // instante durante renegociação, e derrubar a captura a cada piscada
    // produziria justamente a travadinha que a otimização quer evitar.
    if (this.ociosoDesde === null) {
      this.ociosoDesde = agora;
      return;
    }
    if (this.capturaOciosa) return;
    if (agora - this.ociosoDesde < OCIOSO_GRACA_MS) return;

    this.aplicarCaptura(IDLE_CAPTURE_FPS, true);
  }

  /**
   * O framerate que a captura deve ter agora. Ociosa, 5; senão o do degrau
   * escolhido, cortado pela prioridade — `nitidez` captura a 30, e voltar da
   * ociosidade a 60 nesse modo capturava o dobro de quadros para o encoder
   * descartar metade.
   */
  private fpsDaCaptura(ocioso: boolean = this.capturaOciosa): number {
    if (ocioso) return IDLE_CAPTURE_FPS;
    const preset = presetById(this.presetEscolhido);
    return Math.min(preset.main.maxFramerate, FRAMERATE_POR_PRIORIDADE[this.prioridade]);
  }

  private aplicarCaptura(frameRate: number, ocioso: boolean): void {
    const track = this.videoTrack;
    if (track === null || typeof track.applyConstraints !== 'function') return;
    this.capturaOciosa = ocioso;
    const antes = track.getSettings?.();

    /**
     * O conjunto INTEIRO, não só o framerate.
     *
     * `applyConstraints` SUBSTITUI as constraints da trilha; ele não faz
     * merge. Mandar `{ frameRate }` sozinho apagava `width`, `height` e
     * `resizeMode` — e a captura voltava para a resolução NATIVA do monitor.
     *
     * O caminho é o comum, não um canto: toda transmissão começa sem
     * espectador, cai para 5fps depois de dez segundos, e volta quando o
     * primeiro amigo entra. A partir dessa volta, um monitor 1440p ou 4K
     * passava a entregar quadros nativos 60 vezes por segundo, e o
     * redimensionamento virava trabalho extra na mesma máquina que roda o
     * jogo. O `crop-and-scale` existe exatamente para isso não acontecer, e
     * ele era descartado no primeiro ciclo de ociosidade.
     *
     * O sintoma final não é resolução errada — `scaleResolutionDownBy`
     * corrige a saída — é CPU: mais custo por quadro, `qualityLimitationReason
     * = 'cpu'`, e a escada derrubando qualidade por um problema que a
     * otimização de ociosidade criou.
     */
    const preset = presetById(this.presetEscolhido);
    void track
      .applyConstraints({
        frameRate,
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
        resizeMode: 'crop-and-scale',
      } as MediaTrackConstraints)
      .then(() => {
        /**
         * Tamanho novo, escala nova — e a ordem é o ponto.
         *
         * `scaleResolutionDownBy` é calculado a partir do tamanho que a trilha
         * TEM no momento do `setParameters`. Encolher a captura de 1920×1080
         * para 1280×720 com a escala antiga (1,5) ainda em vigor mandava
         * 853×480 para um degrau de 720p: pixel tirado duas vezes. Então, se o
         * tamanho mudou, o degrau efetivo é reenviado agora que a trilha já
         * está no tamanho novo.
         */
        if (this.videoTrack !== track || this.state.status !== 'live') return;
        const depois = track.getSettings?.();
        if (antes?.width === depois?.width && antes?.height === depois?.height) return;
        void this.deps.transport.setPreset(presetById(this.presetId)).catch(() => undefined);
      })
      .catch(() => {
        // Navegador que recusa restringir a captura segue no framerate cheio.
        this.capturaOciosa = false;
      });
  }

  /**
   * A transição vem ANTES da limpeza, e a ordem importa.
   *
   * Enquanto `stop()` esperava o teardown para só então marcar `ended`, a
   * sessão passava um intervalo em `connecting` já condenada — e um `start()`
   * que chegasse nesse intervalo era recusado pela guarda de status. É
   * exatamente o que acontece no ciclo montar/desmontar/montar do React em
   * StrictMode: o remount pedia para transmitir, era recusado em silêncio, e
   * o usuário via "Transmissão encerrada" sem nada ter acontecido.
   *
   * Marcar primeiro também é melhor para quem clica em "parar": a UI responde
   * na hora, e a liberação de câmera, socket e timers segue por baixo.
   */
  async stop(reason: BroadcastFailure = 'USER_STOPPED'): Promise<void> {
    if (this.state.status === 'idle' || this.state.status === 'ended') return;
    this.epoch += 1;
    this.setState({ status: 'ended', reason });
    this.diario.congelar();
    await this.teardown();
  }

  private fail(reason: BroadcastFailure): void {
    this.epoch += 1;
    this.setState({ status: 'ended', reason });
    this.diario.congelar();
    void this.teardown();
  }

  /** Sai de um `start()` que perdeu a corrida, sem tocar no estado. */
  private abandon(): void {
    void this.teardown();
  }

  private async teardown(): Promise<void> {
    for (const cancel of this.timers) cancel();
    this.timers = [];
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];

    this.videoTrack?.stop();
    this.audioTrack?.stop();
    // Fecha o grafo E para a trilha CRUA, que ninguém mais tem referência para
    // parar — quem publicou recebeu a trilha de saída.
    this.deps.gain.close();
    this.videoTrack = null;
    this.audioTrack = null;
    this.audioFonte = null;
    this.origemAudio = null;
    if (this.pausa !== null) {
      this.deps.quadroNeutro?.fechar();
      this.pausa = null;
    }
    this.classificadorAudio.reiniciar();
    this.grafoAudio = 'indisponivel';
    this.preview = null;
    this.malha.reiniciar();
    this.amostras = 0;
    this.vagasPelaBanda = CAPACIDADE_ATE_MEDIR;
    this.ociosoDesde = null;
    this.capturaOciosa = false;

    await this.deps.transport.disconnect();
  }

  /** Só para a UI decidir se pede confirmação ao parar. */
  get viewerCount(): number {
    return this.state.status === 'live' ? this.state.peers.length : 0;
  }
}

function failureFor(error: unknown): BroadcastFailure {
  if (!isSignalingError(error)) return 'SIGNALING_UNAVAILABLE';
  switch (error.code) {
    case 'SLUG_TAKEN':
    case 'OWNER_INVALID':
      // O usuário não distingue "é de outro" de "meu token não bate", e a
      // ação é a mesma: escolher outro nome.
      return 'SLUG_TAKEN';
    case 'SLUG_INVALID':
      return 'SLUG_INVALID';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'PROTOCOL_MISMATCH':
    case 'BAD_MESSAGE':
      // `BAD_MESSAGE` na saudação só acontece com cliente e servidor em
      // versões diferentes: a própria página manda a mensagem.
      return 'OUTDATED';
    case 'SIGNAL_UNREACHABLE':
      return 'SIGNALING_UNAVAILABLE';
    default:
      return 'SIGNALING_UNAVAILABLE';
  }
}
