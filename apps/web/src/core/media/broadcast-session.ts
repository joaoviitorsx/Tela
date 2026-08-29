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
import { CONTENT_HINT_POR_PRIORIDADE, P2P_LIMITS, type Prioridade } from '@tela/shared';
import { UplinkGovernor } from './uplink-governor.js';
import {
  CONTENT_HINT,
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
    this.governor.reset();
    this.amostras = 0;
    this.ociosoDesde = null;
    this.prioridade = 'fluidez';
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
    if (Number.isFinite(lembrado) && lembrado > 0) this.governor.seed(lembrado);
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
     * A referência é o preset ESCOLHIDO, e a inversão em relação à versão
     * anterior é deliberada.
     *
     * Antes media-se contra o CORRENTE, porque a recuperação exigia teto nulo
     * e medir contra o escolhido empurrava o limiar de soltura para longe
     * demais — o teto nunca largava e a recuperação ficava desligada junto.
     *
     * Agora o teto não bloqueia mais a recuperação: ele DEFINE o degrau. Com
     * isso a referência precisa ser estável, senão o sistema oscila de vez —
     * degrada para 480p60, o limiar de soltura cai junto para 2,9 Mbps, o teto
     * solta, o degrau volta a 1080p60, o limiar sobe para 13,8 Mbps, o teto
     * reaplica, e assim por diante uma vez por segundo. Um alvo móvel numa
     * malha de controle é um oscilador.
     *
     * O escolhido não se move sem o usuário mandar. É a única referência que
     * serve.
     */
    const decisao = this.governor.observe(porEspectador);
    // `null` na maioria das leituras: o governador só fala quando a mudança
    // compensa reconfigurar o encoder.
    if (decisao === null) return;
    void this.deps.transport.setUplinkBudget(decisao.bps).catch(() => undefined);

    /**
     * E AQUI está a correção que a ADR 0015 existe para registrar.
     *
     * O teto sempre foi aplicado como `maxBitrate`, e `maxBitrate` sozinho não
     * tira um único pixel do encoder — só aperta o QP. Com um orçamento de
     * 3 Mbps e o degrau parado em 1080p60, o encoder recebia 1920×1080@60 para
     * caber em 0,024 bit por pixel, quando movimento alto pede 0,10. A saída
     * dele era subir o QP até o talo e, logo depois, deixar o *quality scaler*
     * do Chromium derrubar a resolução por conta própria — uma queda que
     * COMPÕE com a nossa e que ninguém mede.
     *
     * A imagem resultante não era quadriculada, era BORRADA: 360p esticado
     * para a tela do espectador, com o produto anunciando 1080p60.
     *
     * Traduzir o orçamento em degrau é o que mantém os bits por pixel
     * honestos. Os mesmos 3 Mbps em 854×480@60 são 0,10 bpp — nítido de
     * verdade, num rótulo menor.
     */
    this.presetPorBanda = presetParaOrcamento(decisao.bps, this.prioridade);
    this.aplicarDegrau();
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
    if (limitation === 'bandwidth' && this.governor.estimativa !== null) {
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

    this.calmaria = 0;
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
    await this.deps.transport.setPrioridade(prioridade);

    /**
     * A 30fps o mesmo orçamento paga o DOBRO de bits por pixel, então cabe uma
     * resolução maior. É assim que `nitidez` entrega 1280×720@30 onde
     * `fluidez` entrega 854×480@60 — pelos mesmos bits, sem pedir um a mais.
     */
    const orcamento = this.governor.orcamento;
    this.presetPorBanda =
      orcamento === null ? null : presetParaOrcamento(orcamento, prioridade);
    this.aplicarDegrau();
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
    // Da prioridade CORRENTE, não a constante: trocar de tela em modo
    // `nitidez` reinstalava `motion` e desfazia a escolha em silêncio.
    capture.video.contentHint = CONTENT_HINT_POR_PRIORIDADE[this.prioridade];
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
    const orcamento = this.governor.orcamento;
    this.presetPorBanda =
      orcamento === null ? null : presetParaOrcamento(orcamento, this.prioridade);

    this.presetId = next;
    this.setState({ ...this.state, presetId: next, presetForced: false, motivoDegradacao: null });
    await this.deps.transport.setPreset(presetById(next));
    this.aplicarDegrau();
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
        width: { ideal: preset.layers[0].width, max: preset.layers[0].width },
        height: { ideal: preset.layers[0].height, max: preset.layers[0].height },
        resizeMode: 'crop-and-scale',
      } as MediaTrackConstraints)
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
