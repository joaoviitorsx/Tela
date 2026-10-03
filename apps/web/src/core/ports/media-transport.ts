import type { EncodingPreset, Prioridade, RelayStatus } from '@tela/shared';
import type { AudioStats } from '../media/audio-stats.js';
import type { ReferenciaDeCaptura } from '../media/relogio-de-captura.js';
import type { PeerInfo } from '../mesh/mesh-topology.js';
import type { EntradaDeEspectador, OpcoesDeHost, PedidoDeEntrada } from './signaling-channel.js';

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

/**
 * O lado de quem assiste, lido de `inbound-rtp`.
 *
 * Nenhum destes campos era coletado. O resultado era que "está travando" e
 * "está atrasado" chegavam como relato e saíam como palpite.
 */
export type RecepcaoStats = {
  /**
   * Atraso MÉDIO do jitter buffer, em ms — `jitterBufferDelay` dividido por
   * `jitterBufferEmittedCount`.
   *
   * É a maior fatia controlável da latência depois da rede, e a única que o
   * produto escolhe de propósito (80ms de piso, ADR 0016). Se ela vier em
   * centenas de ms, o estimador de jitter está acima do nosso piso — e aí o
   * problema é perda ou variação de chegada, não a nossa configuração.
   */
  readonly jitterBufferMs: number | null;
  /**
   * Tudo entre o primeiro pacote RTP chegar e o quadro ser decodificado, em ms.
   *
   * Inclui o jitter buffer, a remontagem do quadro a partir dos pacotes e o
   * decode. É a fatia que faltava para fechar a conta de latência: com RTT/2 e
   * este número, sobra só captura, encode e render — e esses o navegador não
   * expõe ao espectador.
   *
   * A comparação que importa: se `processamentoMs` for muito maior que
   * `jitterBufferMs`, o gargalo é decode ou remontagem, não o buffer que
   * escolhemos. Se forem próximos, é o buffer.
   */
  readonly processamentoMs: number | null;
  /**
   * Só o decode, em ms por quadro. Separado do processamento por um motivo
   * contraintuitivo e medido.
   *
   * Bhuyan et al. (POMACS 6(1) Art. 10), instrumentando o Moonlight, acharam
   * que **o tempo de decode AUMENTA conforme o bitrate CAI**. Ou seja: quando a
   * nossa escada desce um degrau sob pressão, o decode do espectador pode
   * ficar mais lento, não mais rápido — e a queda que devia aliviar cobra em
   * outro lugar.
   *
   * Sem este campo, essa possibilidade fica indistinguível de jitter buffer
   * grande dentro do `processamentoMs`, que engloba os dois.
   */
  readonly decodeMs: number | null;
  /** Quantas vezes a imagem CONGELOU, acumulado na sessão. */
  readonly congelamentos: number;
  /** Tempo total congelado, em segundos. É isto que o usuário chama de travar. */
  readonly tempoCongeladoS: number;
  /** Quadros que chegaram e foram jogados fora — decoder sem dar conta. */
  readonly quadrosDescartados: number;
  /** Pacotes perdidos, acumulado. Perda em rajada vira bloco na tela. */
  readonly pacotesPerdidos: number;
  /**
   * Pedidos de keyframe que ESTE espectador mandou.
   *
   * Cada um custa 6 a 10 vezes um quadro normal (medido e publicado pelo
   * Discord). Um PLI a cada poucos segundos é o ciclo que produz pulso de
   * nitidez e mancha — e é o sintoma clássico de jitter buffer curto demais.
   */
  readonly pedidosDeKeyframe: number;
  /** Como o navegador está decodificando. `null` quando não reporta. */
  readonly decoder: string | null;
};

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
   * A cascata de repasse (ADR 0031), vista do anfitrião: quantos espectadores
   * repassam e para quantos. Ausente fora do anfitrião ou sem cascata.
   */
  readonly repasse?: { readonly repassadores: number; readonly filhos: number };
  /**
   * "Um encode" (D0b): quadros de captura que o codificador deixou de lado
   * por segundo porque os senders tinham fila (contrapressão), e quantos
   * espectadores foram soltos por ficar para trás (`LIMITE_DE_ARRASTO`).
   * É a parte da queda de fps que vem da REDE de alguém, e não da máquina.
   * Ausente fora do "um encode".
   */
  readonly fila?: { readonly seguradosPorSegundo: number; readonly soltos: number };
  /**
   * O que o codificador único PRODUZIU dividido pelo alvo que recebeu. É o
   * sinal que separa "o link caiu" de "a tela parou" sem depender da rede:
   * num colapso o encoder continua produzindo o alvo (quem segura é o pacer);
   * numa cena parada em VBR ele produz uma fração. Ausente fora do "um encode".
   */
  readonly consumoDoEncoder?: number;
  /**
   * Quadros por segundo que a CAPTURA solta, quando difere do que sai do
   * encoder ("um encode" reenvia o último quadro com a captura parada).
   */
  readonly fpsDaCaptura?: number;
  /**
   * A estimativa CRUA de cada caminho, por peer.
   *
   * O governador precisa suavizar cada uma separadamente antes de tirar o
   * mínimo: com ruído de ±20%, `E[min de N]` vale `0,8 + 0,4/(N+1)` da
   * capacidade real, e esse viés fechava a malha de subida a partir de dois
   * espectadores. Mínimo de suavizados ≠ suavizado do mínimo.
   */
  readonly availablePorPeer: Readonly<Record<string, number>>;
  /**
   * Quem foi LIDO neste tique, dentre os de `availablePorPeer` (rodízio, B2).
   * Os demais trazem a leitura retida: valem como estado, não como amostra
   * nova — o governador não os suaviza nem os conta no aquecimento por
   * caminho. Ausente = todos frescos.
   */
  readonly frescosPorPeer?: readonly string[];
  /** RTT (ms) de cada caminho de envio. A congestão é de um caminho (ADR 0033). */
  readonly rttPorPeer?: Readonly<Record<string, number>>;
  /** Perda (0–1, `fractionLost`) que cada espectador reporta de volta. */
  readonly perdaPorPeer?: Readonly<Record<string, number>>;
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
  /**
   * QP médio do encoder — a variável que o `BPP_PISO` só estimava.
   *
   * O `QualityScaler` do libwebrtc derruba resolução quando o QP médio de
   * H.264 passa de **37** (escala 0–51), e sobe de volta abaixo de 24:
   *
   *     const int kLowH264QpThreshold  = 24;
   *     const int kHighH264QpThreshold = 37;
   *
   * Todo o piso de bits por pixel existe como PROXY para "o QP fica abaixo de
   * 37", e a ADR 0010 admite que os 0,10 vieram de literatura, não de medição.
   * `qpSum / framesEncoded` está no mesmo relatório que já coletamos por
   * segundo — dá para medir a coisa em vez do palpite dela.
   *
   * `null` no espectador e onde o navegador não reporta.
   */
  readonly qp: number | null;
  /**
   * Milissegundos por quadro que o ENCODER gasta. `null` sem leitura.
   *
   * É o substituto do `encoderImplementation`, que medimos não existir no
   * caminho de captura de tela — o campo só aparece enquanto há câmera ou
   * microfone vivos. `totalEncodeTime / framesEncoded` está no mesmo relatório
   * e sempre existe.
   *
   * Acima de 16,7 ms em 1080p60 o encoder não acompanha o framerate, e isso é
   * quase sempre encode em SOFTWARE. Importa saber porque o Chrome no Linux
   * vem com H.264 por hardware desligado por padrão: quando é esse o caso,
   * nenhum ajuste de bitrate ajuda, e o produto estava mandando o usuário
   * procurar no lugar errado.
   */
  readonly msPorQuadro: number | null;
  /**
   * O que só o ESPECTADOR sabe. `null` no transmissor.
   *
   * Um relato de "1 segundo de atraso" num caminho de 58ms de RTT significa que
   * ~940ms vêm de outro lugar, e o produto não tinha um único campo capaz de
   * dizer de onde. `MediaStats` era inteiro sobre o envio.
   */
  readonly recepcao: RecepcaoStats | null;
  /**
   * O áudio, medido à parte do vídeo. `null` quando não há fluxo de áudio.
   *
   * Até a TELA-007 não existia: o som saía e chegava sem um número, e
   * problema de origem, de rede e de reprodução eram indistinguíveis.
   */
  readonly audio: AudioStats | null;
};

export type TransportEvents = {
  /** Estado da malha mudou: entrou, saiu, ou o caminho virou relay. */
  peers: readonly PeerInfo[];
  /** Só no espectador: a mídia chegou. */
  track: { stream: MediaStream };
  /**
   * Só no espectador: a conexão com o transmissor FECHOU (ICE + DTLS).
   *
   * Separa "a rede não deixou passar" de "a rede deixou e o vídeo não veio"
   * (TELA-013). Os dois terminavam em "sem rota", e só o primeiro é rota.
   */
  'ice-conectado': void;
  /** Só no espectador: quantos estão assistindo, incluindo ele. */
  viewers: { count: number };
  /** Só no espectador: o pedido está com o transmissor (ADR 0025). */
  'aguardando-aprovacao': void;
  /** Só no transmissor: alguém pede para entrar. */
  pedido: PedidoDeEntrada;
  /** Só no transmissor: o pedido sumiu antes da resposta. */
  'pedido-cancelado': { peerId: string };
  /**
   * Só no transmissor: quem é o espectador que entrou. Vem também na
   * reapresentação depois de um F5 do transmissor, quando a fila já se foi.
   */
  espectador: { peerId: string; nome: string; impressao: string };
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
   *
   * `opcoes.capacidade` é quantos espectadores ESTE transmissor consegue
   * servir, e depende de quem implementa a port: o "um encode, N envios"
   * atende o teto do produto; o mesh puro codifica uma vez por peer e para em
   * poucos. O servidor recebe o número e devolve o teto efetivo.
   */
  host(slug: string, ownerToken: string, opcoes?: OpcoesDeHost): Promise<{ readonly maxPeers: number }>;
  /** Entra num canal como espectador. */
  watch(slug: string, entrada: EntradaDeEspectador): Promise<{ readonly relayStatus: RelayStatus | null }>;
  /**
   * Tira espectadores: o servidor fecha a sinalização deles e o `peer-left`
   * que volta faz a malha fechar o peer. Sem `peerId`, todos.
   */
  removeViewers(peerId?: string): void;
  /** Aceita ou recusa um pedido de entrada (ADR 0025). */
  responderPedido(peerId: string, aceitar: boolean): void;
  /**
   * Quantos espectadores o LINK paga agora, por cima do que a máquina declarou
   * no `host` (ADR 0030). A sessão calcula a partir do orçamento medido e manda
   * ao servidor, que fecha a porta para quem ainda vai entrar — nunca tira quem
   * já está. Opcional: o transporte que não sinaliza (teste, simulador) ignora.
   */
  atualizarCapacidade?(valor: number): void;

  /**
   * Só no espectador: o instante de captura (`abs-capture-time`) do pacote de
   * vídeo mais recente e o último Sender Report, para a sessão calcular o
   * atraso ponta a ponta. `null` sem vídeo, sem a extensão ou sem SR.
   */
  referenciaDeCaptura?(): Promise<ReferenciaDeCaptura | null>;

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
  /**
   * Troca a trilha de áudio sem renegociar quando já existe sender; publica
   * (renegociando) quando não existe. `null` para de mandar som (TELA-012).
   */
  replaceAudio(track: MediaStreamTrack | null): Promise<void>;
  /** O que ceder quando os bits não dão para tudo: fluidez ou nitidez. */
  setPrioridade(prioridade: Prioridade): Promise<void>;
  /**
   * Alvo do jitter buffer do espectador, em ms. Sem efeito no transmissor.
   *
   * É a maior fatia de latência que o produto ESCOLHE. Fixá-la cobra o pior
   * caso de toda conexão, inclusive das calmas; a sessão a dirige a partir do
   * que mede — congelamento e perda.
   */
  setJitterAlvo(ms: number): void;

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
