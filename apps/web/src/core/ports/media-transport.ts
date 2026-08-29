import type { EncodingPreset, Prioridade } from '@tela/shared';
import type { PeerInfo } from '../mesh/mesh-topology.js';

/**
 * A fronteira que sustenta a Fase 3 e que já provou o próprio valor.
 *
 * `core/media/` inteiro fala com esta interface. Quando o transporte trocou de
 * SFU para mesh (changeset 001), `BroadcastSession` e `ViewerSession`
 * continuaram valendo — mudou quem implementa a porta, não quem a usa.
 *
 * REGRA R2: nenhum SDK de SFU no projeto. A implementação viva é
 * `adapters/mesh-transport.ts`; `adapters/_reference/` é documentação.
 */

export type QualityLimitation = 'none' | 'cpu' | 'bandwidth' | 'other';

export type MediaStats = {
  /** Framerate real de saída, medido — não o configurado. */
  readonly fps: number;
  /**
   * Bits por segundo. No transmissor é o TOTAL somado sobre os peers: é esse
   * número que o link de casa precisa aguentar, e é ele que o HUD mostra.
   */
  readonly bitrateBps: number;
  /** Pior RTT entre os peers. O melhor esconderia o amigo com problema. */
  readonly rttMs: number;
  /**
   * O campo mais útil do WebRTC. `cpu` significa que o encoder não dá conta
   * (provavelmente encode em software); `bandwidth`, que a rede não dá.
   */
  readonly limitation: QualityLimitation;
  readonly width: number;
  readonly height: number;
  /**
   * O que o controle de congestionamento acha que cabe no link, em bits/s.
   * `null` enquanto ele ainda não estimou.
   *
   * É a única leitura que dá para comparar com o que o encoder está pedindo —
   * e é comparando os dois que dá para saber se estamos enchendo o cano do
   * usuário, que é o que faz o ping do jogo subir.
   */
  readonly availableBps: number | null;
  /**
   * A PIOR estimativa entre os peers, e o número que de fato manda.
   *
   * Pela R5 todos os senders recebem o MESMO `maxBitrate`, então o que cabe é
   * o que o pior caminho aguenta — não a média. Somar e dividir por N deixava
   * um amigo em ADSL de 5 Mbps recebendo 24 Mbps porque o outro estava em
   * fibra: ~80% de perda contínua para ele, quadriculado permanente, e o
   * transmissor não via nada porque o HUD mostra a soma.
   *
   * A ADR 0017 já declarava a intenção certa — "um espectador com 20 Mbps de
   * descida puxa todo mundo para baixo, e isso é por projeto". O código fazia
   * o oposto.
   */
  readonly piorAvailableBps: number | null;
  /**
   * Quantos peers de fato reportaram estimativa.
   *
   * O divisor era `peers.length`, que conta quem ainda está em `connecting` —
   * e quem está conectando não tem par ICE nominado, logo não contribui para a
   * soma. Numerador e denominador ficavam fora de fase, e cinco amigos
   * entrando de uma vez subestimavam o orçamento em 5× no pior instante.
   */
  readonly paresMedidos: number;
  /**
   * Bits por pixel do fluxo que está saindo POR ESPECTADOR. `0` sem leitura.
   *
   * É o número que prevê a imagem borrada antes de ela aparecer, e o único que
   * dizia a verdade enquanto o rótulo dizia 1080p60: abaixo de 0,10 em
   * movimento alto o encoder não tem saída além de subir o QP, e logo depois o
   * navegador começa a derrubar resolução por conta própria.
   *
   * Deriva de `bitrateBps`, `width`, `height` e `fps` — todos já medidos, sem
   * nenhuma leitura nova.
   */
  readonly bpp: number;
  /**
   * Qual encoder o navegador escolheu, cru: `ExternalEncoder`, `OpenH264`,
   * `libvpx`…
   *
   * É a resposta para a única pergunta de desempenho que o produto não sabia
   * responder sozinho — se o encode está em HARDWARE. Antes só dava para
   * conferir em `chrome://gpu`, o que ninguém faz no meio de uma partida, e
   * `qualityLimitationReason: 'cpu'` só diz que está pesado, não por quê.
   *
   * `null` quando o navegador não reporta o campo.
   */
  readonly encoderImplementation: string | null;
};

export type TransportEvents = {
  /** Estado da malha mudou: entrou, saiu, ou o caminho virou relay. */
  peers: readonly PeerInfo[];
  /** Só no espectador: a mídia chegou. */
  track: { stream: MediaStream };
  /** Só no espectador: quantos estão assistindo, incluindo ele. */
  viewers: { count: number };
  reconnecting: void;
  reconnected: void;
  /**
   * O canal de sinalização caiu, mas a MÍDIA continua.
   *
   * É evento separado de `closed` porque a consequência é totalmente
   * diferente, e confundir os dois quebrava a promessa central da
   * arquitetura: o servidor não está no caminho da mídia, então não deveria
   * estar no caminho da falha. Quem já está conectado continua vendo; só
   * espectadores novos não entram.
   */
  'signaling-lost': void;
  /**
   * O canal voltou. Espectadores novos conseguem entrar de novo.
   *
   * Sem esta contraparte, `signaling-lost` era uma porta de mão única: um
   * restart de dois segundos do servidor — um deploy — tirava o transmissor
   * do ar pelo resto da sessão, e a única saída era parar e recomeçar,
   * derrubando justamente os espectadores que a arquitetura protegeu.
   */
  'signaling-restored': void;
  /** A mídia acabou. Aí sim é fim. */
  closed: { reason: string };
};

export type Unsubscribe = () => void;

export type MediaTransport = {
  /**
   * Reivindica o canal e passa a esperar espectadores.
   *
   * Devolve o teto que o SERVIDOR aplica. Antes devolvia `void`, e a sessão
   * ficava com um palpite local que nada corrigia — o HUD chegava a mostrar
   * "5/3" com cinco espectadores conectados, porque o palpite era 3 e o
   * servidor aceitava 5.
   */
  host(slug: string, ownerToken: string): Promise<{ readonly maxPeers: number }>;
  /** Entra num canal como espectador. */
  watch(slug: string): Promise<void>;

  publishVideo(track: MediaStreamTrack, preset: EncodingPreset): Promise<void>;
  publishAudio(track: MediaStreamTrack): Promise<void>;
  /** Troca de qualidade sem renegociar: `setParameters` nos senders. */
  setPreset(preset: EncodingPreset): Promise<void>;
  /**
   * Troca a fonte de vídeo sem derrubar ninguém.
   *
   * `replaceTrack` substitui o que sai por um sender existente e NÃO mexe no
   * SDP: quem está assistindo não pisca, não renegocia, não reconecta. É a
   * diferença entre trocar de janela e recomeçar a transmissão.
   */
  replaceVideo(track: MediaStreamTrack): Promise<void>;
  /** O que ceder quando os bits não dão para tudo: fluidez ou nitidez. */
  setPrioridade(prioridade: Prioridade): Promise<void>;
  /**
   * Quantos bits o link comporta POR ESPECTADOR, medidos. `null` = sem medição.
   *
   * Chamava-se `setBitrateCeiling` e o nome descrevia meia função: era um teto,
   * só falava para APERTAR, e quem tinha banda de sobra nunca era informado —
   * ficava no nominal do preset, que é calibração e não alvo. Um link de
   * 800 Mbps entregava 12 Mbps por isso (ADR 0017).
   *
   * O preset diz qual RESOLUÇÃO cabe; este número diz quantos bits há para
   * gastar nela. Quem gasta é a topologia, até o teto útil de bits por pixel.
   */
  setUplinkBudget(bps: number | null): Promise<void>;

  /**
   * Em mesh há N senders, então não existe "o sender". O total de upload e o
   * pior RTT são os dois números que descrevem a saúde da transmissão.
   */
  getAggregateStats(): Promise<MediaStats | null>;
  peers(): readonly PeerInfo[];

  on<K extends keyof TransportEvents>(
    event: K,
    handler: (payload: TransportEvents[K]) => void,
  ): Unsubscribe;

  disconnect(): Promise<void>;
};

export type { PeerInfo };
