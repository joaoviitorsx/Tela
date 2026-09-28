import { Emitter } from '../emitter.js';
import { ClassificadorDeAudio, type EstadoAudio } from './audio-state.js';
import { CODIGO_AUDIO, type Diagnostico, Diario, idLocal } from './diagnostico.js';
import { JITTER_MINIMO_MS } from '../mesh/peer-link.js';
import { JitterGovernor } from './jitter-governor.js';
import { type EstadoLatencia, LatencyWatch } from './latency-watch.js';
import type { MediaStats, MediaTransport } from '../ports/media-transport.js';
import type { AmostraLatencia } from '../ports/frame-timing.js';
import type { Cancel, Scheduler } from '../ports/scheduler.js';
import { isSignalingError } from '../ports/signaling-channel.js';
import type { RelayStatus } from '@tela/shared';

/**
 * A sessão do espectador. Sem React e sem conhecer o transporte concreto.
 *
 * Ela cuida do caso que decide o produto para quem recebe o link: o amigo abre
 * a página antes do jogo começar. Em vez de erro, ele vê "offline" e a página
 * conecta sozinha quando a transmissão subir.
 */
export type ViewerState =
  | { readonly status: 'checking' }
  | { readonly status: 'offline'; readonly slug: string; readonly nextPollMs: number }
  | { readonly status: 'connecting'; readonly slug: string }
  | {
      readonly status: 'watching';
      readonly slug: string;
      readonly stream: MediaStream;
      readonly hasAudio: boolean;
      /** Quantos estão assistindo, incluindo este. Mínimo 1. */
      readonly viewers: number;
      readonly stats: MediaStats | null;
      /** O que dá para afirmar sobre o som que chega. Ver `audio-state.ts`. */
      readonly audio: EstadoAudio;
    }
  /**
   * A mídia hesitou, mas ela AINDA ESTÁ AQUI — e é por isso que o stream vem
   * junto.
   *
   * Sem este campo a rota não tinha o que renderizar e caía na tela de espera,
   * desmontando o `<video>`. Só que `reconnecting` é emitido em dois gatilhos
   * baratíssimos — `track.onmute` e `connectionState === 'disconnected'` — e
   * nenhum dos dois significa que a mídia parou: uma troca de AP no Wi-Fi
   * falha os consent checks do ICE por alguns segundos com o mesmo par de
   * candidatos entregando pacotes o tempo todo.
   *
   * O resultado era o oposto do que os 80ms de jitter buffer compram: o
   * transporte absorvia o soluço e a UI jogava fora, arrancando um vídeo que
   * nunca parou e montando um `<video>` novo, preto até o próximo quadro. É a
   * "travadinha" dos relatos.
   *
   * `null` só quando a mídia nunca chegou.
   */
  | {
      readonly status: 'reconnecting';
      readonly slug: string;
      readonly stream: MediaStream | null;
    }
  | { readonly status: 'full'; readonly slug: string }
  /**
   * Negociou e a mídia nunca chegou.
   *
   * O caso típico é NAT simétrico dos dois lados sem TURN: o WebRTC troca SDP,
   * monta tudo, e nenhum pacote atravessa. Merece estado próprio porque a
   * ação do usuário é diferente de "offline" — não adianta esperar.
   */
  | {
      readonly status: 'sem-conexao';
      readonly slug: string;
      readonly relayStatus?: RelayStatus | null;
      /**
       * Onde parou (TELA-013). `rede`: a conexão nunca fechou — aí sim é rota,
       * e o relay importa. `midia`: conectou e o primeiro quadro não veio;
       * culpar o NAT mandaria a pessoa mexer no roteador à toa.
       */
      readonly etapa: 'rede' | 'midia';
    }
  /**
   * Não conseguimos nem falar com o servidor.
   *
   * Diferente de "offline": ali existe servidor e não existe transmissão;
   * aqui não se sabe, porque a pergunta não chegou. Bloqueio de navegador,
   * proxy corporativo, rede caída.
   */
  | { readonly status: 'sem-servidor'; readonly slug: string }
  /**
   * Convite (TELA-018). Três estados, porque as ações são três:
   *
   * - `convite-ausente`: o link não trazia o segredo. Nem se tenta a rede —
   *   não há o que mandar.
   * - `convite-invalido`: o transmissor renovou. Só um link novo resolve,
   *   então não se insiste sozinho.
   * - `removido`: o transmissor tirou este espectador. Voltar sozinho seria
   *   desfazer a escolha dele.
   */
  | { readonly status: 'convite-ausente'; readonly slug: string }
  | { readonly status: 'convite-invalido'; readonly slug: string }
  | { readonly status: 'removido'; readonly slug: string }
  /**
   * Aprovação manual (ADR 0025). O convite valeu e o pedido está com o
   * transmissor — que pode estar no meio de uma partida. Esperar aqui é o
   * caminho normal, então nenhum relógio de conexão corre.
   */
  | { readonly status: 'aguardando-aprovacao'; readonly slug: string; readonly nome: string }
  /** O transmissor recusou. Pedir de novo é gesto da pessoa, nunca do laço. */
  | { readonly status: 'recusado'; readonly slug: string }
  /** Página de uma versão que o servidor não fala mais: recarregar resolve. */
  | { readonly status: 'desatualizado'; readonly slug: string };

export type ViewerEventMap = { state: ViewerState };

export type ViewerSessionDeps = {
  /** Fábrica: cada tentativa precisa de um canal novo, não de um reaberto. */
  transport: () => MediaTransport;
  scheduler: Scheduler;
  statsIntervalMs?: number;
  recoveryTimeoutMs?: number;
  diagnosticId?: () => string;
  appVersion?: string | null;
};

/** Antes da primeira amostra: só se sabe se a trilha existe. */
function audioInicial(stream: MediaStream): EstadoAudio {
  return stream.getAudioTracks().length > 0 ? 'desconhecido' : 'sem-fonte';
}

/** Erros em que tentar de novo sozinho não muda a resposta. */
const FIM_SEM_RETRY: Partial<Record<string, 'convite-invalido' | 'removido' | 'recusado' | 'desatualizado'>> = {
  INVITE_INVALID: 'convite-invalido',
  REMOVED: 'removido',
  DENIED: 'recusado',
  PROTOCOL_MISMATCH: 'desatualizado',
  BAD_MESSAGE: 'desatualizado',
};

/** Polling de 5s com backoff até 30s: a aba pode ficar aberta a tarde inteira. */
const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 30_000;
const POLL_FACTOR = 1.5;
const STATS_INTERVAL_MS = 1_000;
/**
 * Teto para a negociação. O `watch` só entrega mídia quando o primeiro frame
 * chega — e se a oferta nunca vier, a promessa não resolve NEM rejeita. Sem
 * este relógio a aba fica "conectando" para sempre.
 */
const CONNECT_TIMEOUT_MS = 15_000;

export class ViewerSession {
  private readonly emitter = new Emitter<ViewerEventMap>();
  private state: ViewerState = { status: 'checking' };
  private transport: MediaTransport | null = null;
  private stream: MediaStream | null = null;

  /**
   * Duas listas separadas, e a separação é o que impede a tempestade de
   * reconexão. `transportCancels` morre junto com o transporte; `retryCancel`
   * é uma vaga ÚNICA, então agendar de novo substitui em vez de somar.
   */
  private transportCancels: Cancel[] = [];
  private retryCancel: Cancel | null = null;

  /**
   * O jitter buffer deixou de ser constante.
   *
   * Ele é a maior fatia de latência que o produto escolhe, e um número fixo
   * cobra o pior caso de toda conexão. Este governador o move a partir do que a
   * recepção reporta — sobe rápido no congelamento, desce devagar na calmaria.
   */
  private readonly jitter = new JitterGovernor();

  /**
   * A série temporal, para o usuário MANDAR em vez de descrever.
   *
   * Um relato de "cerca de um segundo de atraso" é indiagnosticável sem ela:
   * os ~940ms que faltam para os 58ms de rede podem estar no encoder, no jitter
   * buffer, na fila do roteador ou no decoder.
   */
  private readonly diario = new Diario('espectador');

  private readonly classificadorAudio = new ClassificadorDeAudio();
  /**
   * O que a PÁGINA sabe sobre a reprodução, e a sessão não: se o navegador
   * bloqueou o autoplay e se a pessoa silenciou. Informado pela UI.
   */
  private reproducao = { bloqueada: false, mudo: false };

  /**
   * O teto duro de latência.
   *
   * `jitterBufferTarget` é um piso sem contraparte: nenhuma API impõe um TETO
   * ao buffer de playout. Quando o estimador decide que precisa de meio
   * segundo, ele fica com meio segundo, e baixar o nosso piso não muda nada.
   * Reconectar é a única alavanca que sobra — e é por isso que ela só é puxada
   * depois que o ajuste barato falhou.
   */
  private readonly latencia = new LatencyWatch();

  private epoch = 0;
  /** Última contagem de plateia recebida. Fora do `attempt` porque a
   *  reconexão remonta o estado `watching` e precisa do mesmo número. */
  private plateia = 1;
  private pollMs = POLL_MIN_MS;
  private slug = '';
  /** Segredo do link. `null` quando o link veio sem ele. */
  private invite: string | null = null;
  /** Como o transmissor vai ver o pedido, e a chave deste navegador. */
  private quem: { readonly nome: string; readonly chave: string } = { nome: '', chave: '' };
  /** O pedido está com o transmissor: o relógio de conexão não corre. */
  private aguardando = false;
  private readonly participantId: string;
  private disposed = false;
  /** Cancela o listener de visibilidade. */
  private unwatchVisibility: Cancel | null = null;
  /** `true` quando a próxima tentativa foi adiada por a aba estar escondida. */
  private adiadoPorVisibilidade = false;

  constructor(private readonly deps: ViewerSessionDeps) {
    this.participantId = (deps.diagnosticId ?? idLocal)();
  }

  getState(): ViewerState {
    return this.state;
  }

  /**
   * Uma medida vinda do quadro apresentado. Chamada a 60 Hz pelo adapter, então
   * é barata de propósito: só alimenta uma média móvel.
   */
  registrarLatencia(amostra: AmostraLatencia): void {
    this.latencia.registrar(amostra);
  }

  /** A latência ponta a ponta que o espectador está sentindo. */
  get latenciaAtual(): EstadoLatencia {
    return this.latencia.estado;
  }

  /**
   * A reprodução é da página: só ela vê o `play()` recusado e o botão de mudo.
   * Entra na próxima amostra — o classificador conta amostras, e uma chamada
   * extra fora do relógio contaria a mesma medida duas vezes.
   */
  informarReproducao(reproducao: { readonly bloqueada: boolean; readonly mudo: boolean }): void {
    this.reproducao = { ...reproducao };
  }

  /** Nada sai da máquina sozinho: a UI copia, a pessoa decide se manda. */
  diagnostico(navegador: string): Diagnostico | null {
    return this.diario.vazio ? null : this.diario.relatorio(navegador);
  }

  subscribe(listener: () => void): () => void {
    return this.emitter.on('state', listener);
  }

  private setState(next: ViewerState): void {
    if (next.status !== this.state.status) {
      const agora = this.deps.scheduler.now();
      switch (next.status) {
        case 'checking':
          this.diario.evento('session', 'START', agora);
          break;
        case 'connecting':
          this.diario.evento('signaling', 'CONNECTING', agora);
          break;
        case 'watching':
          this.diario.evento('session', 'WATCHING', agora);
          break;
        case 'reconnecting':
          this.diario.evento('session', 'RECONNECTING', agora);
          break;
        case 'offline':
          this.diario.evento('session', 'OFFLINE', agora);
          break;
        case 'full':
          this.diario.evento('signaling', 'FULL', agora);
          break;
        case 'sem-conexao':
          if (next.etapa === 'midia') this.diario.evento('video', 'MEDIA_TIMEOUT', agora);
          else this.diario.evento('ice', 'NO_ROUTE', agora);
          break;
        case 'sem-servidor':
          this.diario.evento('signaling', 'SIGNALING_UNAVAILABLE', agora);
          break;
        case 'convite-ausente':
          this.diario.evento('session', 'INVITE_MISSING', agora);
          break;
        case 'convite-invalido':
          this.diario.evento('signaling', 'INVITE_INVALID', agora);
          break;
        case 'removido':
          this.diario.evento('session', 'REMOVED', agora);
          break;
        case 'aguardando-aprovacao':
          this.diario.evento('signaling', 'AWAITING_APPROVAL', agora);
          break;
        case 'recusado':
          this.diario.evento('session', 'DENIED', agora);
          break;
        case 'desatualizado':
          this.diario.evento('signaling', 'OUTDATED', agora);
          break;
      }
    }
    this.state = next;
    this.emitter.emit('state', next);
  }

  private stale(epoch: number): boolean {
    return this.disposed || this.epoch !== epoch;
  }

  async open(
    slug: string,
    invite: string | null = null,
    quem: { readonly nome: string; readonly chave: string } = this.quem,
  ): Promise<void> {
    // O epoch sobe ANTES de qualquer await. React em StrictMode monta, desmonta
    // e monta de novo, então dois `open` correm juntos — e o segundo precisa
    // invalidar o primeiro no instante em que começa, não depois do primeiro
    // `await`. Sem isso os dois seguem vivos e um pisa no outro.
    this.epoch += 1;
    const epoch = this.epoch;

    this.slug = slug;
    this.invite = invite;
    this.quem = quem;
    this.disposed = false;
    this.pollMs = POLL_MIN_MS;

    this.cancelRetry();
    this.jitter.reset();
    this.latencia.reset();
    this.classificadorAudio.reiniciar();
    this.diario.iniciar((this.deps.diagnosticId ?? idLocal)(), this.deps.appVersion ?? null);
    this.diario.evento('session', 'START', this.deps.scheduler.now());
    await this.dropTransport();
    if (this.stale(epoch)) return;

    // Sem segredo no link não há o que mandar ao servidor: nem se tenta.
    if (this.invite === null) {
      this.setState({ status: 'convite-ausente', slug: this.slug });
      return;
    }

    this.unwatchVisibility?.();
    this.unwatchVisibility = this.deps.scheduler.onVisibilityChange(() => {
      // Voltou a olhar: retoma na hora em vez de esperar o próximo tique.
      if (this.adiadoPorVisibilidade && this.deps.scheduler.isVisible()) {
        this.adiadoPorVisibilidade = false;
        this.pollMs = POLL_MIN_MS;
        void this.attempt(epoch);
      }
    });

    this.setState({ status: 'checking' });
    await this.attempt(epoch);
  }

  private async attempt(
    epoch: number,
    opcoes: { readonly manterImagem?: boolean } = {},
  ): Promise<void> {
    if (this.stale(epoch)) return;
    this.retryCancel = null;

    /**
     * Aba escondida: não faz nada.
     *
     * Quem deixou a aba do espectador aberta e foi jogar não precisa de nada
     * da rede — ele não está olhando. Ficar reconectando gasta o link e a
     * atenção de uma máquina que está no meio de uma partida, e o produto
     * inteiro existe para não atrapalhar isso.
     */
    if (!this.deps.scheduler.isVisible()) {
      this.adiadoPorVisibilidade = true;
      this.goOffline();
      return;
    }
    this.adiadoPorVisibilidade = false;
    this.diario.tentativa((this.deps.diagnosticId ?? idLocal)(), this.deps.scheduler.now());

    /*
      `connecting` não carrega stream, e a rota desmonta o `<video>` para
      qualquer estado que não seja `watching` ou `reconnecting` com imagem.
      Quando já HÁ mídia — o caso da reconexão por latência — o estado certo é
      `reconnecting`, que preserva o elemento.
    */
    this.setState(
      opcoes.manterImagem === true
        ? { status: 'reconnecting', slug: this.slug, stream: this.stream }
        : { status: 'connecting', slug: this.slug },
    );

    /**
     * O transporte é LOCAL desta tentativa até dar certo.
     *
     * Publicá-lo em `this.transport` antes da hora fazia uma tentativa obsoleta
     * derrubar, na limpeza dela, o transporte de uma tentativa viva — e a
     * rejeição que sobrava era reportada como "offline" quando o motivo real
     * era outro (canal cheio, por exemplo). Estado de uma tentativa só vira
     * estado da sessão quando a tentativa vence.
     */
    const transport = this.deps.transport();
    const cancels: Cancel[] = [];
    this.aguardando = false;

    let delivered = false;
    let iceConectou = false;
    let relayStatus: RelayStatus | null = null;
    /**
     * Relógio da MÍDIA, separado do relógio da negociação.
     *
     * O defeito que isto conserta: o teto de 15s corria contra a promessa de
     * `watch()`, e `watch()` resolve assim que o servidor responde `watching`
     * — antes de qualquer pacote de vídeo. O relógio era cancelado nesse
     * instante, `delivered()` nunca chegava a ser consultado, e o estado
     * `sem-conexao` era INALCANÇÁVEL. Na prática: NAT simétrico dos dois lados
     * sem TURN deixava a página dizendo "aguardando sinal" para sempre, com um
     * transmissor no ar do outro lado.
     */
    let vigiaMidia: Cancel | null = null;
    let recoveryStarted = false;
    let extendVigia: (() => void) | null = null;
    const desarmarVigia = (): void => {
      vigiaMidia?.();
      vigiaMidia = null;
    };

    cancels.push(
      transport.on('aguardando-aprovacao', () => {
        if (this.stale(epoch)) return;
        this.aguardando = true;
        this.setState({ status: 'aguardando-aprovacao', slug: this.slug, nome: this.quem.nome });
      }),
      transport.on('ice-conectado', () => {
        if (this.stale(epoch)) return;
        iceConectou = true;
      }),
      transport.on('track', ({ stream }) => {
        if (this.stale(epoch)) return;
        /**
         * Só VÍDEO entrega a transmissão (TELA-013, §8.2).
         *
         * O `unmute` do áudio também emite `track`, e costuma chegar primeiro.
         * Tratá-lo como entrega desarmava o vigia do vídeo e declarava
         * `watching` numa tela preta — exatamente o "está tudo bem" mentiroso
         * que o vigia existe para impedir. O áudio entra no stream e espera.
         */
        if (stream.getVideoTracks().length === 0) {
          this.stream = stream;
          if (this.state.status === 'watching') {
            this.setState({ ...this.state, hasAudio: stream.getAudioTracks().length > 0 });
          }
          return;
        }
        delivered = true;
        desarmarVigia();
        this.pollMs = POLL_MIN_MS;
        this.stream = stream;
        this.setState({
          status: 'watching',
          slug: this.slug,
          stream,
          // Reavaliado a cada `track`: o áudio costuma chegar depois do vídeo,
          // e é este campo que faz aparecer o overlay de ativar o som.
          hasAudio: stream.getAudioTracks().length > 0,
          viewers: this.plateia,
          stats: this.state.status === 'watching' ? this.state.stats : null,
          audio: this.state.status === 'watching' ? this.state.audio : audioInicial(stream),
        });
      }),
      transport.on('viewers', ({ count }) => {
        this.plateia = Math.max(1, count);
        if (this.stale(epoch)) return;
        if (this.state.status !== 'watching') return;
        this.setState({ ...this.state, viewers: this.plateia });
      }),
      transport.on('reconnecting', () => {
        recoveryStarted = true;
        extendVigia?.();
        if (this.state.status === 'watching') {
          this.setState({ status: 'reconnecting', slug: this.slug, stream: this.stream });
        }
      }),
      // Sem este par, `reconnecting` era beco sem saída. Ele resolveu o beco,
      // mas não a desmontagem: a rota continuava trocando o <video> por uma
      // tela de espera a cada soluço. Isso saiu junto com o `stream` no
      // estado, acima.
      transport.on('reconnected', () => this.onReconnected(epoch)),
      /**
       * O espectador não muda de estado por causa do canal: ele está vendo
       * vídeo que não passa pelo servidor. O adapter reconecta sozinho por
       * baixo, e a única consequência visível seria perder o `peer-left` do
       * transmissor — que a carência de mídia já cobre.
       */
      transport.on('signaling-lost', () => undefined),
      transport.on('signaling-restored', () => undefined),
      transport.on('closed', ({ reason }) => void this.onClosed(epoch, reason)),
    );

    const abandonar = async (): Promise<void> => {
      for (const cancel of cancels) cancel();
      cancels.length = 0;
      if (this.transport === transport) {
        this.transport = null;
        this.stream = null;
      }
      await transport.disconnect();
    };

    try {
      const opened = await this.withTimeout(transport.watch(this.slug, {
        invite: this.invite ?? '',
        nome: this.quem.nome,
        chave: this.quem.chave,
        participantId: this.participantId,
        attemptId: (this.deps.diagnosticId ?? idLocal)(),
      }), epoch);
      relayStatus = opened.relayStatus;
      this.aguardando = false;
      // Aceito: daqui em diante é conexão, e é isso que a tela diz.
      if (!this.stale(epoch) && this.state.status === 'aguardando-aprovacao') {
        this.setState({ status: 'connecting', slug: this.slug });
      }
      if (!this.stale(epoch) && relayStatus !== null) {
        this.diario.evento('turn', relayStatus === 'available' ? 'RELAY_AVAILABLE'
          : relayStatus === 'unavailable' ? 'RELAY_UNAVAILABLE' : 'RELAY_NOT_CONFIGURED',
        this.deps.scheduler.now());
      }
    } catch (error) {
      this.aguardando = false;
      await abandonar();
      if (this.stale(epoch)) return;
      if (isSignalingError(error) && error.code === 'CHANNEL_FULL') {
        // Sala cheia não é erro permanente: alguém sai, a vaga abre.
        this.setState({ status: 'full', slug: this.slug });
        this.advanceBackoff();
      } else if (isSignalingError(error) && FIM_SEM_RETRY[error.code] !== undefined) {
        // Insistir com o mesmo convite, ou na mesma versão, dá o mesmo não.
        this.setState({ status: FIM_SEM_RETRY[error.code]!, slug: this.slug });
        return;
      } else if (
        isSignalingError(error) &&
        (error.code === 'SIGNAL_UNREACHABLE' || error.code === 'HELLO_TIMEOUT')
      ) {
        /**
         * `HELLO_TIMEOUT` é socket que ABRIU e emudeceu — servidor pendurado,
         * proxy que aceita a conexão e não repassa. Caía no `else` e virava
         * "ninguém está transmitindo", que manda a pessoa esperar por algo que
         * não vai acontecer. É problema de servidor, e a mensagem é essa.
         */
        this.setState({ status: 'sem-servidor', slug: this.slug });
        this.advanceBackoff();
      } else if (error instanceof Error && error.message === 'CONNECT_TIMEOUT') {
        // O canal abriu, o SDP foi trocado, e a mídia não veio. Isso não é
        // "ninguém transmitindo" — é a rede entre os dois não fechando.
        this.setState({
          status: 'sem-conexao', slug: this.slug, relayStatus,
          etapa: iceConectou ? 'midia' : 'rede',
        });
        this.advanceBackoff();
      } else {
        this.goOffline();
      }
      return this.scheduleRetry(epoch);
    }

    /**
     * O canal abriu. Daqui em diante o que pode faltar é MÍDIA, e é outro
     * problema com outra mensagem: "não foi possível conectar ao vídeo" em
     * vez de "ninguém está transmitindo". Esperar não resolve nenhum dos
     * dois, mas só um deles se resolve sozinho.
     */
    if (!delivered) {
      const timeout = () => {
        if (this.stale(epoch) || delivered) return;
        vigiaMidia = null;
        void (async () => {
          await abandonar();
          if (this.stale(epoch)) return;
          this.setState({
            status: 'sem-conexao', slug: this.slug, relayStatus,
            etapa: iceConectou ? 'midia' : 'rede',
          });
          this.advanceBackoff();
          this.scheduleRetry(epoch);
        })();
      };
      const arm = (delay: number): void => {
        desarmarVigia();
        vigiaMidia = this.deps.scheduler.after(delay, timeout);
      };
      arm(recoveryStarted ? (this.deps.recoveryTimeoutMs ?? 30_000) : CONNECT_TIMEOUT_MS);
      if (!recoveryStarted) {
        extendVigia = () => {
          if (delivered) return;
          arm(this.deps.recoveryTimeoutMs ?? 30_000);
          extendVigia = null;
        };
      }
      cancels.push(desarmarVigia);
    }

    if (this.stale(epoch)) {
      await abandonar();
      return;
    }

    // Venceu: agora sim vira estado da sessão.
    cancels.push(
      this.deps.scheduler.every(this.deps.statsIntervalMs ?? STATS_INTERVAL_MS, () =>
        void this.sampleStats(),
      ),
    );
    this.transport = transport;
    this.transportCancels = cancels;
  }

  /**
   * Teto para a NEGOCIAÇÃO abrir o canal.
   *
   * Já teve um parâmetro `delivered` aqui, e ele era a origem do defeito: a
   * intenção era esperar a mídia, mas este relógio é cancelado no instante em
   * que a promessa resolve — e a promessa é a do `watch`, que resolve no
   * `watching` do servidor, antes de qualquer pacote. A espera pela mídia é
   * outro relógio, armado depois deste, em `attempt`.
   */
  private withTimeout<T>(promise: Promise<T>, epoch: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let cancel: Cancel = () => undefined;
      const armar = (): void => {
        cancel = this.deps.scheduler.after(CONNECT_TIMEOUT_MS, () => {
          if (settled || this.stale(epoch)) return;
          // Esperando o transmissor responder não é negociação travada.
          if (this.aguardando) return armar();
          settled = true;
          reject(new Error('CONNECT_TIMEOUT'));
        });
      };
      armar();
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          cancel();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cancel();
          reject(error);
        },
      );
    });
  }

  private async sampleStats(): Promise<void> {
    if (this.state.status !== 'watching' || this.transport === null) return;
    const stats = await this.transport.getAggregateStats();
    if (stats === null) return;
    if (this.state.status !== 'watching') return;
    const agora = this.deps.scheduler.now();
    const trilha = this.state.stream.getAudioTracks()[0];
    const audio = this.classificadorAudio.observar({
      trilha: trilha === undefined ? 'ausente' : trilha.readyState === 'ended' ? 'encerrada' : 'viva',
      mudoIntencional: this.reproducao.mudo && !this.reproducao.bloqueada,
      reproducaoBloqueada: this.reproducao.bloqueada,
      stats: stats.audio,
      agora,
    });
    if (audio !== this.state.audio) this.diario.evento('audio', CODIGO_AUDIO[audio], agora);
    this.setState({ ...this.state, stats, audio });

    // Devolve latência quando a conexão prova que aguenta, e a retoma no
    // primeiro sinal de que não aguentava.
    const decisao = this.jitter.observe(stats.recepcao);
    if (decisao !== null) this.transport?.setJitterAlvo(decisao.ms);
    this.diario.registrar(stats, agora);

    /**
     * O último recurso, e ele só é alcançado quando o primeiro se esgotou.
     *
     * `podeDescer` é o governador dizendo que ainda tem buffer para devolver.
     * Enquanto tiver, a resposta certa é devolver — reconectar custa alguns
     * segundos de imagem, e um vigia com gatilho errado troca uma transmissão
     * ruim por nenhuma.
     */
    /*
      "O ajuste barato ainda tem saída?" — e a pergunta certa não é só se o
      alvo está acima do piso. Com perda sustentada o governador sobe até o
      teto e fica lá; o alvo fica alto, mas ele não tem mais nada a tentar.
      Perguntar só pelo piso desarmava o vigia exatamente no caso que ele
      existe para cobrir.
    */
    const podeDescer = this.jitter.atual > JITTER_MINIMO_MS && !this.jitter.noTeto;
    if (this.latencia.deveReconectar(podeDescer)) void this.reabrirPorLatencia(this.epoch);
  }

  private onReconnected(epoch: number): void {
    if (this.stale(epoch)) return;
    if (this.state.status !== 'reconnecting') return;
    const stream = this.stream;
    if (stream === null) return;
    this.setState({
      status: 'watching',
      slug: this.slug,
      stream,
      hasAudio: stream.getAudioTracks().length > 0,
      viewers: this.plateia,
      stats: null,
      audio: audioInicial(stream),
    });
  }

  /**
   * Reconecta porque a latência não desceu de outro jeito.
   *
   * Precedente: o watchdog da Rainway com `bufferLimitMs: 500`, que reiniciava
   * o stream em vez de deixar o buffer crescer. Grosseiro, e é a alavanca que o
   * navegador deixa.
   *
   * Passa por `attempt`, o mesmo caminho da reconexão comum, então o
   * `<video>` não é desmontado: o estado `reconnecting` carrega o stream desde
   * a ADR 0018.
   */
  private async reabrirPorLatencia(epoch: number): Promise<void> {
    if (this.stale(epoch)) return;

    /**
     * O epoch sobe e o transporte VELHO morre, nesta ordem. Sem os dois isto
     * era pior que o problema que conserta.
     *
     * `attempt()` publica `this.transport` e `this.transportCancels` sem olhar
     * o que havia antes — todos os outros chamadores garantem que não há
     * transporte vivo (o `open` faz `dropTransport`, os retries só rodam depois
     * de `abandonar`). Este é o primeiro que entra com a sessão em `watching` e
     * uma conexão VIVA.
     *
     * Medido: os cancelamentos anteriores eram sobrescritos sem serem
     * invocados, e o transporte órfão nunca recebia `disconnect()`. Pior — ele
     * ficava com os handlers registrados no MESMO epoch, então quando a
     * conexão dele morria sozinha, `onClosed` não era considerado obsoleto e
     * derrubava o transporte NOVO. O espectador reconectava e, segundos depois,
     * perdia a imagem que já tinha voltado.
     *
     * E com o vigia rearmado a cada volta (ver abaixo), 400 segundos de
     * latência alta produziam 302 WebSockets e 302 `RTCPeerConnection` vivos
     * numa aba. Cada aba contava como vários espectadores no servidor.
     */
    this.epoch += 1;
    const novoEpoch = this.epoch;
    await this.dropTransport();
    if (this.stale(novoEpoch)) return;

    /**
     * O vigia perde só a MÉDIA, e conserva o `jaAgiu`.
     *
     * `reset()` limpava também a marca de já ter agido, e como quem chama é a
     * própria reconexão, a garantia de "uma vez por sessão" — a terceira
     * defesa contra o falso positivo — nunca valia. Se reconectar não
     * resolveu, o problema não é o buffer, e insistir troca uma transmissão
     * ruim por nenhuma.
     */
    this.jitter.reset();
    this.latencia.esquecerMedida();

    /**
     * `reconnecting` COM o stream, e `attempt` avisado para não regredir.
     *
     * Sem o segundo argumento, `attempt` sobrescrevia com `connecting`, que não
     * carrega stream — e `connecting` cai no early return da rota, desmontando
     * o `<video>`. Ou seja: a reconexão que existe para consertar a latência
     * reintroduzia, por outro caminho, exatamente a tela preta que a ADR 0018
     * tirou.
     */
    this.setState({ status: 'reconnecting', slug: this.slug, stream: this.stream });
    await this.attempt(novoEpoch, { manterImagem: this.stream !== null });
  }


  private async onClosed(epoch: number, reason: string): Promise<void> {
    if (this.stale(epoch)) return;
    await this.dropTransport();
    if (this.stale(epoch)) return;
    if (reason === 'REMOVED') {
      this.cancelRetry();
      this.setState({ status: 'removido', slug: this.slug });
      return;
    }
    this.pollMs = POLL_MIN_MS;
    this.goOffline();
    this.scheduleRetry(epoch);
  }

  /** Ação manual preserva a sessão e a vaga; não recarrega a página. */
  async retryNow(): Promise<void> {
    if (this.disposed || this.slug === '') return;
    this.epoch += 1;
    const epoch = this.epoch;
    this.cancelRetry();
    await this.dropTransport();
    if (this.stale(epoch)) return;
    this.pollMs = POLL_MIN_MS;
    await this.attempt(epoch);
  }

  private goOffline(): void {
    this.setState({ status: 'offline', slug: this.slug, nextPollMs: this.pollMs });
  }

  private advanceBackoff(): void {
    this.pollMs = Math.min(Math.round(this.pollMs * POLL_FACTOR), POLL_MAX_MS);
  }

  /**
   * Vaga única. Chamar duas vezes na mesma rodada — o que acontece quando a
   * negociação rejeita E o transporte emite `closed` — não agenda duas
   * tentativas nem avança o backoff duas vezes.
   */
  private scheduleRetry(epoch: number): void {
    if (this.stale(epoch)) return;
    if (this.retryCancel !== null) return;

    const delay = this.pollMs;
    this.advanceBackoff();
    this.retryCancel = this.deps.scheduler.after(delay, () => {
      this.retryCancel = null;
      void this.attempt(epoch);
    });
  }

  private cancelRetry(): void {
    this.retryCancel?.();
    this.retryCancel = null;
  }

  private async dropTransport(): Promise<void> {
    for (const cancel of this.transportCancels) cancel();
    this.transportCancels = [];
    this.stream = null;
    const transport = this.transport;
    this.transport = null;
    await transport?.disconnect();
  }

  async close(): Promise<void> {
    this.diario.evento('session', 'ENDED', this.deps.scheduler.now());
    this.diario.congelar();
    this.disposed = true;
    this.epoch += 1;
    this.cancelRetry();
    this.unwatchVisibility?.();
    this.unwatchVisibility = null;
    await this.dropTransport();
  }
}
