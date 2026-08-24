import { Emitter } from '../emitter.js';
import type { AudioCapture } from '../ports/audio-capture.js';
import type { AudioGain } from '../ports/audio-gain.js';
import type {
  MediaStats,
  MediaTransport,
  PeerInfo,
  QualityLimitation,
} from '../ports/media-transport.js';
import type { Scheduler } from '../ports/scheduler.js';
import type { CaptureSurface, ScreenCapture } from '../ports/screen-capture.js';
import { isSignalingError } from '../ports/signaling-channel.js';
import { P2P_LIMITS, type Prioridade } from '@tela/shared';
import { UplinkGovernor } from './uplink-governor.js';
import {
  CONTENT_HINT,
  DEFAULT_PRESET_ID,
  type PresetId,
  nextPresetOnCpuPressure,
  presetById,
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
  | 'CAPTURE_UNSUPPORTED'
  | 'SLUG_TAKEN'
  | 'SLUG_INVALID'
  | 'RATE_LIMITED'
  | 'SIGNALING_UNAVAILABLE'
  | 'TRANSPORT_FAILED'
  | 'USER_STOPPED'
  | 'CAPTURE_ENDED';

/**
 * União discriminada: estado impossível não é representável.
 * Não existe `live` sem link, nem `ended` sem motivo.
 */
export type BroadcastState =
  | { readonly status: 'idle' }
  | { readonly status: 'requesting-capture' }
  | { readonly status: 'connecting' }
  | {
      readonly status: 'live';
      readonly shareUrl: string;
      readonly slug: string;
      readonly presetId: PresetId;
      readonly presetForced: boolean;
      readonly peers: readonly PeerInfo[];
      readonly maxPeers: number;
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
  /** Monta o link público a partir do slug. Sem servidor, quem sabe é o front. */
  shareUrlFor: (slug: string) => string;
  /**
   * O que o link deste aparelho sustentou da última vez, por espectador.
   *
   * Opcional: sem ele o governador simplesmente aquece do zero, como antes.
   */
  uplinkMemory?: { read(): string | null; write(value: string): void };
  /** `MediaStream` é global de browser; `core/` não constrói um direto. */
  createStream: (tracks: readonly MediaStreamTrack[]) => MediaStream;
  maxPeers?: number;
  statsIntervalMs?: number;
};

const STATS_INTERVAL_MS = 1_000;
/** Quantas leituras seguidas com o mesmo limitador antes de cair de preset. */
const PRESSURE_SAMPLES = 5;

/**
 * Amostras de calmaria antes de devolver um degrau. Doze vezes mais lento que
 * a descida, de propósito — ver `recuperar()`.
 */
const CALMARIA_AMOSTRAS = 60;

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
  private timers: Array<() => void> = [];
  private unsubscribes: Array<() => void> = [];
  private presetId: PresetId = DEFAULT_PRESET_ID;
  /** O que o usuário pediu. A recuperação sobe até aqui e para. */
  private presetEscolhido: PresetId = DEFAULT_PRESET_ID;
  /** Amostras seguidas sem aperto nenhum. */
  private calmaria = 0;
  /** Amostras seguidas com o encoder entregando zero frame, havendo plateia. */
  private semImagem = 0;
  /** Grava a estimativa de banda de vez em quando, não a cada segundo. */
  private desdeGravacao = 0;
  private pressure = 0;
  private pressureKind: QualityLimitation = 'none';
  private capturaOciosa = false;
  /** Palpite até o servidor dizer o dele, no `hosting`. Nunca um número solto. */
  private maxPeers: number = P2P_LIMITS.maxViewersBrowser;
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
  private readonly governor = new UplinkGovernor();
  private amostras = 0;
  private ociosoDesde: number | null = null;
  private surface: CaptureSurface = 'desconhecido';
  private preview: MediaStream | null = null;
  private prioridade: Prioridade = 'fluidez';

  constructor(private readonly deps: BroadcastSessionDeps) {
    // Nunca um número solto: `3` aqui sobrevivia até o `hosting` responder, e
    // nesse meio-tempo o HUD e as vagas desenhavam três de um canal que aceita
    // cinco — contradizendo o texto da própria Home, que lê `P2P_LIMITS`.
    this.maxPeers = deps.maxPeers ?? P2P_LIMITS.maxViewersBrowser;
  }

  getState(): BroadcastState {
    return this.state;
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
    this.state = next;
    this.emitter.emit('state', next);
  }

  private stale(epoch: number): boolean {
    return this.epoch !== epoch;
  }

  async start(
    slug: string,
    ownerToken: string,
    options: { audioDeviceId?: string; presetId?: PresetId } = {},
  ): Promise<void> {
    if (this.state.status !== 'idle' && this.state.status !== 'ended') return;

    this.epoch += 1;
    const epoch = this.epoch;

    this.presetId = options.presetId ?? DEFAULT_PRESET_ID;
    this.presetEscolhido = this.presetId;

    /**
     * Começa já sabendo o que o link deu da última vez.
     *
     * Sem isto, o aquecimento do governador deixa os primeiros oito segundos
     * de TODA transmissão sem teto — e é exatamente quando os espectadores
     * que estavam esperando entram de uma vez e o controle de congestionamento
     * sobe procurando o limite do link, N vezes em paralelo.
     */
    const lembrado = Number(this.deps.uplinkMemory?.read() ?? '');
    if (Number.isFinite(lembrado) && lembrado > 0) this.governor.seed(lembrado);
    this.pressure = 0;
    this.pressureKind = 'none';
    this.capturaOciosa = false;
    this.governor.reset();
    this.amostras = 0;
    this.ociosoDesde = null;
    this.prioridade = 'fluidez';
    this.setState({ status: 'requesting-capture' });

    const preset = presetById(this.presetId);

    if (!this.deps.screen.isSupported()) return this.fail('CAPTURE_UNSUPPORTED');

    let capture;
    try {
      capture = await this.deps.screen.request({
        width: preset.layers[0].width,
        height: preset.layers[0].height,
        frameRate: preset.main.maxFramerate,
        systemAudio: true,
      });
    } catch (error) {
      if (this.stale(epoch)) return;
      return this.fail(error === 'UNSUPPORTED' ? 'CAPTURE_UNSUPPORTED' : 'CAPTURE_DENIED');
    }

    // O usuário pode ter desistido durante o picker do sistema.
    if (this.stale(epoch)) {
      capture.video.stop();
      capture.audio?.stop();
      return;
    }

    this.videoTrack = capture.video;
    this.audioTrack = capture.audio;
    this.surface = capture.surface;

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
    this.videoTrack.contentHint = CONTENT_HINT;

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
    if (this.audioTrack !== null) {
      this.audioTrack = this.deps.gain.attach(this.audioTrack);
      // Antes de publicar: senão o primeiro segundo sai no volume cheio, que
      // é justamente o susto que o controle existe para evitar.
      this.deps.gain.set(this.volumeTransmissao);
    }

    // O usuário pode encerrar pelo controle nativo do browser, fora da nossa UI.
    this.videoTrack.addEventListener('ended', () => void this.stop('CAPTURE_ENDED'));

    this.setState({ status: 'connecting' });

    try {
      // O servidor é a autoridade sobre o teto; o palpite local só vale até aqui.
      const aberto = await this.deps.transport.host(slug, ownerToken);
      if (Number.isFinite(aberto.maxPeers) && aberto.maxPeers > 0) {
        this.maxPeers = aberto.maxPeers;
      }
    } catch (error) {
      if (this.stale(epoch)) return this.abandon();
      return this.fail(failureFor(error));
    }
    if (this.stale(epoch)) return this.abandon();

    this.unsubscribes.push(
      this.deps.transport.on('peers', (peers) => this.onPeers(peers)),
      this.deps.transport.on('signaling-lost', () => this.onSignalingLost()),
      this.deps.transport.on('signaling-restored', () => this.onSignalingRestored()),
      this.deps.transport.on('closed', () => void this.stop('TRANSPORT_FAILED')),
    );

    try {
      await this.deps.transport.publishVideo(this.videoTrack, preset);
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
      presetForced: false,
      peers: [],
      maxPeers: this.maxPeers,
      stats: null,
      hasAudio: this.audioTrack !== null,
      capturaSemImagem: false,
      motivoDegradacao: null,
      volumeAudio: this.volumeTransmissao,
      volumeAjustavel: this.deps.gain.ativo,
      semSinalizacao: false,
      preview: this.preview,
      prioridade: this.prioridade,
      audioPerdidoPelaEscolha:
        this.audioTrack === null &&
        this.surface !== 'monitor' &&
        this.surface !== 'desconhecido',
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
    this.setState({ ...this.state, stats });
    this.applyUplinkCeiling(stats.availableBps, this.state.peers.length);
    this.trackPressure(stats.limitation);
    this.trackCapturaMorta(stats.fps);
    this.lembrarBanda();
  }

  /**
   * Impede o encoder de encher o cano do usuário.
   *
   * O WebRTC estima quanto cabe no link e sobe até lá. "Até lá" é exatamente
   * onde a fila do roteador enche e o ping do jogo dispara — e quando o
   * controle de congestionamento percebe, o jogador já sentiu. Então o teto é
   * aplicado ANTES: o vídeo nunca pede mais do que uma fração do estimado.
   */
  private applyUplinkCeiling(availableBps: number | null, espectadores: number): void {
    /**
     * A estimativa chega SOMADA entre os peers; o teto sai POR sender.
     *
     * `stats-sampler` soma `availableOutgoingBitrate` de todas as conexões,
     * porque para o HUD o que interessa é o total que sai do link de casa. Mas
     * `setBitrateCeiling` grava o número como `maxBitrate` de CADA sender — e
     * em mesh cada espectador recebe uma cópia inteira do vídeo.
     *
     * Sem esta divisão o erro era proporcional ao número de espectadores e
     * sempre na direção de ENCHER o cano, que é precisamente o que esta malha
     * existe para impedir: com 3 espectadores num link de 12 Mbps o teto
     * liberava 8 Mbps por sender, ou seja, 24 Mbps de demanda num cano de 12.
     *
     * É a mesma conta que `suggestPreset` e `p2pViewerBudget` já faziam em
     * `@tela/shared` — a malha de controle é que estava fora de compasso.
     */
    const porEspectador =
      availableBps === null ? null : availableBps / Math.max(1, espectadores);
    /**
     * A referência é o preset CORRENTE.
     *
     * Medir contra o escolhido foi tentado e empurra o limiar de soltura para
     * `maxBitrate × 1,15 / 0,75` — 12,3 Mbps POR ESPECTADOR no 1080p60, ou
     * 61 Mbps de link com cinco. Na prática o teto nunca soltava, e como a
     * recuperação exige teto nulo, ela ficava desligada junto.
     */
    const decisao = this.governor.observe(porEspectador, presetById(this.presetId));
    // `null` na maioria das leituras: o governador só decide quando a mudança
    // compensa reconfigurar o encoder. `{ bps: null }` remove o teto.
    if (decisao === null) return;
    void this.deps.transport.setBitrateCeiling(decisao.bps).catch(() => undefined);
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
    this.calmaria = 0;
    if (limitation !== this.pressureKind) {
      this.pressureKind = limitation;
      this.pressure = 0;
    }
    this.pressure += 1;
    if (this.pressure < PRESSURE_SAMPLES) return;

    const next = nextPresetOnCpuPressure(this.presetId);
    this.pressure = 0;
    if (next === null) return;

    const causa = this.pressureKind;
    this.presetId = next;
    if (this.state.status === 'live') {
      this.setState({ ...this.state, presetId: next, presetForced: true, motivoDegradacao: causa });
    }
    // `catch` obrigatório: fire-and-forget aqui já produziu unhandled
    // rejection quando colidiu com uma troca manual de qualidade.
    void this.deps.transport.setPreset(presetById(next)).catch(() => undefined);
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
    const estimativa = this.governor.estimativa;
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
  private trackCapturaMorta(fps: number): void {
    if (this.state.status !== 'live') return;

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
    if (this.presetId === this.presetEscolhido) {
      this.calmaria = 0;
      return;
    }
    /**
     * Teto de upload em vigor significa que a banda NÃO está sobrando — o
     * WebRTC só não reclama porque já estamos segurando o encoder. Subir aqui
     * seria pedir mais do que o link dá e cair de novo em segundos.
     */
    if (this.governor.ceiling !== null) {
      this.calmaria = 0;
      return;
    }

    this.calmaria += 1;
    if (this.calmaria < CALMARIA_AMOSTRAS) return;
    this.calmaria = 0;

    const acima = previousPresetOnRecovery(this.presetId, this.presetEscolhido);
    if (acima === null) return;

    this.presetId = acima;
    if (this.state.status === 'live') {
      this.setState({
        ...this.state,
        presetId: acima,
        presetForced: acima !== this.presetEscolhido,
        motivoDegradacao: acima === this.presetEscolhido ? null : this.state.motivoDegradacao,
      });
    }
    void this.deps.transport.setPreset(presetById(acima)).catch(() => undefined);
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
    if (this.state.status === 'live') this.setState({ ...this.state, prioridade });
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
    const preset = presetById(this.presetId);

    let capture;
    try {
      capture = await this.deps.screen.request({
        width: preset.layers[0].width,
        height: preset.layers[0].height,
        frameRate: preset.main.maxFramerate,
        systemAudio: true,
      });
    } catch {
      // Cancelar o seletor é desistir da troca, não da transmissão.
      return;
    }
    if (this.stale(epoch)) {
      capture.video.stop();
      capture.audio?.stop();
      return;
    }

    const anterior = this.videoTrack;
    capture.video.contentHint = CONTENT_HINT;
    capture.video.addEventListener('ended', () => void this.stop('CAPTURE_ENDED'));

    this.videoTrack = capture.video;
    this.surface = capture.surface;
    this.preview = this.deps.createStream([capture.video]);

    await this.deps.transport.replaceVideo(capture.video);

    // Só depois de a nova estar no ar: parar antes deixaria um buraco visível.
    anterior?.stop();

    if (this.state.status !== 'live') return;
    this.setState({
      ...this.state,
      preview: this.preview,
      audioPerdidoPelaEscolha:
        this.audioTrack === null &&
        this.surface !== 'monitor' &&
        this.surface !== 'desconhecido',
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
    if (next === this.presetId) return;

    this.presetId = next;
    // Escolha manual redefine o teto da recuperação: é a nova intenção.
    this.presetEscolhido = next;
    this.pressure = 0;
    this.pressureKind = 'none';
    this.calmaria = 0;
    this.setState({ ...this.state, presetId: next, presetForced: false, motivoDegradacao: null });
    await this.deps.transport.setPreset(presetById(next));
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
      if (this.capturaOciosa) this.setCaptureFps(presetById(this.presetId).main.maxFramerate, false);
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

    this.setCaptureFps(IDLE_CAPTURE_FPS, true);
  }

  private setCaptureFps(frameRate: number, ocioso: boolean): void {
    const track = this.videoTrack;
    if (track === null || typeof track.applyConstraints !== 'function') return;
    this.capturaOciosa = ocioso;
    void track.applyConstraints({ frameRate }).catch(() => {
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
    await this.teardown();
  }

  private fail(reason: BroadcastFailure): void {
    this.epoch += 1;
    void this.teardown();
    this.setState({ status: 'ended', reason });
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
    this.preview = null;
    this.governor.reset();
    this.amostras = 0;
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
    case 'SIGNAL_UNREACHABLE':
      return 'SIGNALING_UNAVAILABLE';
    default:
      return 'SIGNALING_UNAVAILABLE';
  }
}
