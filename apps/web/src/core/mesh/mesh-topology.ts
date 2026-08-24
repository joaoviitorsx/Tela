import {
  DEGRADATION_BY_PRIORITY,
  type EncodingPreset,
  type IceServerConfig,
  type Prioridade,
} from '@tela/shared';
import { Emitter } from '../emitter.js';
import { PeerLink } from './peer-link.js';

/**
 * A malha vista do transmissor: uma `PeerLink` por espectador.
 *
 * # A regra que protege o FPS do jogo
 *
 * **Todos os peers recebem parâmetros de encoding IDÊNTICOS.**
 *
 * O Chrome reaproveita o mesmo encoder entre `RTCRtpSender`s cujos parâmetros
 * batem: um encode, três envios. Varie o bitrate por peer e viram três
 * encoders 1080p60 disputando a GPU com o jogo — que é exatamente o recurso
 * que este produto existe para proteger.
 *
 * Portanto a adaptação é **coletiva**: se um espectador tem rede ruim, ou ele
 * aguenta o que está sendo enviado, ou todos descem juntos um degrau. É a
 * quarta regra de mídia do AGENTS.md R5, e a que mais parece errada à
 * primeira vista — alguém vai tentar "otimizar" isto depois. Não deixe.
 */
export type PeerInfo = {
  readonly id: string;
  readonly connectionState: RTCPeerConnectionState;
  /** `true` quando o caminho passa por TURN: latência maior, cota consumida. */
  readonly usingRelay: boolean;
};

export type TopologyEvents = {
  peers: readonly PeerInfo[];
  /** Um peer atingiu estado terminal e foi removido. */
  dropped: { peerId: string };
};

export type MeshTopologyDeps = {
  readonly iceServers: readonly IceServerConfig[];
  readonly send: (payload: unknown, to: string) => void;
  readonly createConnection: (config: RTCConfiguration) => RTCPeerConnection;
  readonly maxPeers: number;
};

/**
 * Quanto a captura precisa encolher para caber no preset.
 *
 * A trilha é capturada na resolução do preset ESCOLHIDO e congelada ali. Quando
 * a degradação desce um degrau, é este fator que faz o encoder trabalhar menos
 * pixel de verdade — `maxBitrate` sozinho só aperta o QP.
 *
 * `1` quando não há o que encolher: `scaleResolutionDownBy` menor que 1 é
 * inválido, e aumentar resolução acima da captura não existe.
 */
function escalaPara(track: MediaStreamTrack | null, preset: EncodingPreset): number {
  const alvo = preset.layers[0].width;
  const atual = track?.getSettings?.().width ?? 0;
  if (!Number.isFinite(atual) || atual <= 0 || alvo <= 0 || atual <= alvo) return 1;
  return atual / alvo;
}

/** Áudio de jogo, não de voz: 128 kbps preserva música e efeitos. */
const AUDIO_BITRATE = 128_000;

export class MeshTopology {
  private readonly emitter = new Emitter<TopologyEvents>();
  private readonly links = new Map<string, PeerLink>();
  private readonly senders = new Map<string, RTCRtpSender[]>();
  private readonly relayed = new Set<string>();

  /** Trilhas publicadas, reaplicadas em todo peer que entra depois. */
  private stream: MediaStream | null = null;
  private tracks: MediaStreamTrack[] = [];
  private preset: EncodingPreset | null = null;

  /**
   * Espectadores que chegaram antes de existir mídia.
   *
   * Sem esta fila, um `peer-joined` que caísse na janela entre abrir o canal e
   * publicar a primeira trilha era perdido em silêncio, e o espectador ficava
   * em "conectando" para sempre (ADR 0006, A1).
   */
  private readonly waiting = new Set<string>();

  /**
   * Uma renegociação por peer, em fila.
   *
   * Duas chamadas concorrentes na mesma `RTCPeerConnection` se intercalavam e
   * uma delas retomava num objeto já fechado — `InvalidStateError` (ADR 0006,
   * A3). O gatilho é real: a queda automática por CPU e um clique manual no
   * seletor de qualidade podem cair no mesmo instante.
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Teto de upload, abaixo do preset. `null` = sem teto.
   *
   * O preset diz o que o usuário quer; o teto diz o que o link dele aguenta
   * sem estrangular o jogo. Vence o menor dos dois — encher o cano é
   * exatamente o que faz o ping do jogo subir.
   */
  private ceiling: number | null = null;
  private prioridade: Prioridade = 'fluidez';

  /**
   * Começa com o que veio do canal, mas NÃO é fixo: o canal reabre com
   * credenciais de TURN novas e quem entrar depois precisa das novas.
   */
  private iceServers: readonly IceServerConfig[];

  constructor(private readonly deps: MeshTopologyDeps) {
    this.iceServers = deps.iceServers;
  }

  /** Chamado quando o canal de sinalização reabre com credenciais novas. */
  setIceServers(iceServers: readonly IceServerConfig[]): void {
    this.iceServers = iceServers;
  }

  on<K extends keyof TopologyEvents>(
    event: K,
    handler: (payload: TopologyEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  get size(): number {
    return this.links.size;
  }

  get peers(): readonly PeerInfo[] {
    return [...this.links.values()].map((link) => ({
      id: link.peerId,
      connectionState: link.connectionState,
      usingRelay: this.relayed.has(link.peerId),
    }));
  }

  /** Chamado quando o servidor de sinalização anuncia um espectador. */
  admit(peerId: string): void {
    const existente = this.links.get(peerId);
    if (existente !== undefined) {
      /**
       * Link saudável com este peer JÁ existe — não derrube.
       *
       * Quando o transmissor reabre o canal depois de uma queda, o servidor
       * reapresenta todos os espectadores que continuaram conectados. Tratar
       * essa reapresentação como "peer novo" destruiria exatamente as
       * conexões que sobreviveram ao servidor, que é a promessa da
       * arquitetura. Só recria o que já morreu.
       */
      if (existente.connectionState !== 'failed' && existente.connectionState !== 'closed') {
        return;
      }
      /**
       * Rede de segurança, não caminho quente: `onStateChange` já derruba o
       * link em `failed`/`closed`, então na prática nada que continue neste
       * mapa está morto. Fica porque o custo é uma comparação e a alternativa
       * é um peer preso para sempre se aquele callback falhar.
       */
      this.drop(peerId);
    }
    if (this.links.size >= this.deps.maxPeers) return;

    if (this.stream === null || this.preset === null) {
      this.waiting.add(peerId);
      return;
    }
    this.attach(peerId);
  }

  private attach(peerId: string): void {
    const stream = this.stream;
    const preset = this.preset;
    if (stream === null || preset === null) return;

    // O transmissor é impolite: ele tem a mídia e não recua na colisão.
    const link = new PeerLink({
      peerId,
      polite: false,
      iceServers: this.iceServers,
      send: (payload) => this.deps.send(payload, peerId),
      createConnection: this.deps.createConnection,
      onStateChange: (state) => {
        if (state === 'failed' || state === 'closed') this.drop(peerId);
        else this.announce();
      },
    });

    this.links.set(peerId, link);

    try {
      const senders = this.tracks.map((track) => link.addTrack(track, stream));
      this.senders.set(peerId, senders);
      void this.applyPreset(senders, preset);
    } catch {
      // Falhar ao anexar deixaria uma conexão viva contando como espectador,
      // sem oferta nenhuma no ar (ADR 0006, A2).
      this.drop(peerId);
      return;
    }

    this.announce();
  }

  drop(peerId: string): void {
    const link = this.links.get(peerId);
    this.waiting.delete(peerId);
    if (link === undefined) return;
    link.close();
    this.links.delete(peerId);
    this.senders.delete(peerId);
    this.relayed.delete(peerId);
    this.emitter.emit('dropped', { peerId });
    this.announce();
  }

  async handleSignal(from: string, payload: unknown): Promise<void> {
    const link = this.links.get(from);
    if (link === undefined) return;
    try {
      await link.handleSignal(payload);
    } catch {
      this.drop(from);
    }
  }

  /**
   * Publica (ou republica) a mídia para todo mundo.
   *
   * Trilha adicionada DEPOIS que um peer já conectou também precisa chegar
   * nele. O caso real é o áudio: a captura de tela resolve primeiro, o áudio
   * do sink virtual vem uns instantes depois, e um espectador que entrou no
   * meio ficaria sem som para sempre — sem erro, sem aviso, só silêncio.
   *
   * `addTrack` numa conexão já estabelecida dispara `negotiationneeded`, e o
   * perfect negotiation do `PeerLink` cuida da renegociação.
   */
  publish(stream: MediaStream, tracks: readonly MediaStreamTrack[], preset: EncodingPreset): Promise<void> {
    this.stream = stream;
    this.tracks = [...tracks];
    this.preset = preset;

    return this.enqueue(async () => {
      // Quem estava esperando mídia entra agora.
      for (const peerId of [...this.waiting]) {
        this.waiting.delete(peerId);
        this.attach(peerId);
      }
      // Quem já estava conectado recebe o que ainda não tinha.
      for (const [peerId, link] of this.links) this.syncTracks(peerId, link, stream);
      await this.adaptAll(preset);
    });
  }

  /** Garante que este peer tem um sender para cada trilha publicada. */
  private syncTracks(peerId: string, link: PeerLink, stream: MediaStream): void {
    const senders = this.senders.get(peerId) ?? [];
    const enviadas = new Set(senders.map((sender) => sender.track).filter(Boolean));

    for (const track of this.tracks) {
      if (enviadas.has(track)) continue;
      try {
        senders.push(link.addTrack(track, stream));
      } catch {
        // Conexão fechando no meio. O `connectionstatechange` cuida do resto.
        return;
      }
    }
    this.senders.set(peerId, senders);
  }

  /**
   * Troca de qualidade sem renegociar.
   *
   * `setParameters` nos senders existentes não mexe no SDP — ninguém pisca, e
   * a corrida entre duas renegociações concorrentes deixa de existir na raiz.
   */
  setPreset(preset: EncodingPreset): Promise<void> {
    this.preset = preset;
    return this.enqueue(() => this.adaptAll(preset));
  }

  /**
   * Troca a trilha de vídeo em todos os peers, sem renegociar.
   *
   * `replaceTrack` opera no sender já negociado, então o SDP não muda e nada
   * do outro lado percebe — nem um piscar. Renegociar aqui derrubaria a
   * imagem de todo mundo a cada troca de janela.
   */
  replaceVideo(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    this.stream = stream;
    this.tracks = [track, ...this.tracks.filter((t) => t.kind !== 'video')];

    return this.enqueue(async () => {
      for (const senders of this.senders.values()) {
        for (const sender of senders) {
          if (sender.track?.kind !== 'video') continue;
          try {
            await sender.replaceTrack(track);
          } catch {
            // Peer fechando no meio da troca; o estado dele cuida do resto.
          }
        }
      }
      if (this.preset !== null) await this.adaptAll(this.preset);
    });
  }

  setPrioridade(prioridade: Prioridade): Promise<void> {
    this.prioridade = prioridade;
    const preset = this.preset;
    if (preset === null) return Promise.resolve();
    return this.enqueue(() => this.adaptAll(preset));
  }

  setCeiling(bps: number | null): Promise<void> {
    this.ceiling = bps;
    const preset = this.preset;
    if (preset === null) return Promise.resolve();
    return this.enqueue(() => this.adaptAll(preset));
  }

  private async adaptAll(preset: EncodingPreset): Promise<void> {
    const alvo = [...this.senders.values()].flat();
    await Promise.all(alvo.map((sender) => this.applyPreset([sender], preset)));
  }

  /**
   * Parâmetros IDÊNTICOS em todo sender. Ver o bloco no topo do arquivo:
   * variar por peer multiplica encoders e rouba CPU do jogo.
   */
  private async applyPreset(senders: readonly RTCRtpSender[], preset: EncodingPreset): Promise<void> {
    for (const sender of senders) {
      if (sender.track?.kind === 'audio') {
        await this.applyAudioParams(sender);
        continue;
      }
      if (sender.track?.kind !== 'video') continue;

      const params = sender.getParameters();
      /**
       * Sender sem `encodings` ainda: NÃO invente um.
       *
       * A spec (webrtc-pc §5.2) manda rejeitar `setParameters` quando
       * `parameters.encodings.length` difere de `[[SendEncodings]].length`.
       * O código antigo mandava `[{}]` para um sender que tinha zero, o que
       * pede `InvalidModificationError` — e como a rejeição era engolida, o
       * peer ficava com os DEFAULTS do browser para sempre: sem `maxBitrate`,
       * sem `maxFramerate`, sem `networkPriority`, sem `degradationPreference`.
       *
       * Isso é violação direta da R5: parâmetros diferentes entre peers fazem
       * o Chrome parar de reaproveitar o encoder, e viram N encoders 1080p60
       * disputando a GPU com o jogo.
       */
      if (!params.encodings?.length) {
        this.pendentes.add(sender);
        continue;
      }

      const encodings = params.encodings;
      encodings[0] = {
        /**
         * O único parâmetro que de fato tira PIXEL do encoder.
         *
         * Sem ele, trocar de preset em execução não mudava nada: a resolução é
         * fixada uma vez no `getDisplayMedia` e nunca mais. Descer a escada
         * baixava o bitrate mantendo 1920×1080 a 60fps — 124 milhões de pixels
         * por segundo com menos bits para cada um, ou seja, exatamente o
         * quadriculado que a escada existia para evitar. Medido: um teto de
         * 3 Mbps rendia 0,0241 bit por pixel, e "otimizar" o preset sem isto
         * levava a 0,0201. Menos bits, zero pixels a menos.
         *
         * Todos os peers recebem o mesmo fator, porque ele deriva do preset
         * (que é coletivo pela R5) e da trilha (que é uma só). A invariante do
         * encoder reaproveitado continua de pé.
         */
        scaleResolutionDownBy: escalaPara(sender.track, preset),
          ...encodings[0],
          maxBitrate: this.effectiveBitrate(preset),
          maxFramerate: preset.main.maxFramerate,
          /**
           * `medium`, e a mudança de `low` foi deliberada.
           *
           * `networkPriority` vira marcação DSCP. A intenção original era
           * ceder passagem ao netcode do jogo — correto em rede CABEADA com
           * fila consciente (fq_codel, CAKE), onde `low` vira CS1 e o roteador
           * atende o jogo primeiro.
           *
           * Em Wi-Fi ele sai pela culatra. CS1 mapeia para a categoria WMM
           * AC_BK, "background", que NÃO é apenas menos prioritária: ela tem
           * parâmetros de contenção PIORES que o tráfego comum, espera mais
           * para transmitir e perde disputa para qualquer outra coisa no
           * mesmo ar. Perda em rajada durante um movimento rápido vira bloco
           * na tela até o próximo keyframe.
           *
           * A defesa contra bufferbloat que de fato funciona é o teto de
           * upload — nunca pedir mais do que o link aguenta. Essa continua de
           * pé, e é ela que protege o ping do jogo. O DSCP era um bônus que
           * dependia do roteador, e num dos dois meios ele cobrava caro.
           */
          networkPriority: 'medium',
        };
      try {
        await sender.setParameters({
          ...params,
          encodings,
          // O que ceder sob aperto: por padrão resolução, nunca framerate.
          degradationPreference: DEGRADATION_BY_PRIORITY[this.prioridade],
        } as RTCRtpSendParameters);
        this.pendentes.delete(sender);
      } catch {
        /**
         * `setParameters` é TUDO OU NADA.
         *
         * O comentário anterior aqui dizia que "o encoding continua aplicado"
         * e que só o `degradationPreference` era recusado. É falso pela spec:
         * se a chamada rejeita, NADA foi aplicado — e quem lesse isso pararia
         * de investigar exatamente onde o defeito estava.
         *
         * Segunda tentativa sem `degradationPreference`, que é o membro que
         * alguns motores de fato recusam. Bitrate e framerate valem mais que
         * a preferência de degradação, e é melhor aplicar os dois do que
         * perder os três.
         */
        try {
          await sender.setParameters({ ...params, encodings } as RTCRtpSendParameters);
          this.pendentes.delete(sender);
        } catch {
          // Falhou duas vezes: fica na fila para a próxima amostra de stats.
          this.pendentes.add(sender);
        }
      }
    }
  }

  /**
   * Senders que ainda não aceitaram os parâmetros.
   *
   * `attach` chama `applyPreset` em fire-and-forget e é a ÚNICA chamada que um
   * peer recebe em regime estacionário — sem esta fila, um peer que falhasse
   * na primeira tentativa nunca mais seria configurado.
   */
  private readonly pendentes = new Set<RTCRtpSender>();

  /**
   * Nova tentativa para quem ficou de fora, no ritmo das estatísticas.
   *
   * Aproveita o relógio que já existe em vez de criar outro: `collectStats`
   * roda uma vez por segundo enquanto há peer.
   */
  private async reaplicarPendentes(): Promise<void> {
    if (this.pendentes.size === 0 || this.preset === null) return;
    const alvo = [...this.pendentes].filter((sender) => sender.track !== null);
    this.pendentes.clear();
    if (alvo.length === 0) return;
    await this.applyPreset(alvo, this.preset);
  }

  /**
   * Parâmetros do áudio do jogo.
   *
   * 128 kbps porque o WebRTC assume voz e aperta demais por padrão — trilha
   * de jogo com música vira lata. E o bitrate é o ÚNICO ajuste feito aqui:
   * DTX e RED se negociam no SDP, e ligá-los seria ruim de propósito. DTX
   * corta o que ele acha que é silêncio, e em jogo isso vira gaguejo; RED
   * manda redundância, e redundância custa latência.
   */
  private async applyAudioParams(sender: RTCRtpSender): Promise<void> {
    try {
      const params = sender.getParameters();
      const encodings = params.encodings?.length ? params.encodings : [{}];
      // Áudio tem prioridade ALTA: se algo tem que ceder sob aperto de rede,
      // é a imagem. Vídeo picotado dá para acompanhar; som picotado, não.
      encodings[0] = { ...encodings[0], maxBitrate: AUDIO_BITRATE, networkPriority: 'high' };
      await sender.setParameters({ ...params, encodings } as RTCRtpSendParameters);
    } catch {
      // Navegador que recusa o campo continua transmitindo no default.
    }
  }

  /** O menor entre o que o usuário pediu e o que o link aguenta. */
  private effectiveBitrate(preset: EncodingPreset): number {
    if (this.ceiling === null) return preset.main.maxBitrate;
    return Math.min(preset.main.maxBitrate, this.ceiling);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  /** Marca quais peers estão passando por TURN, para a UI poder avisar. */
  async refreshRelayStatus(isRelayed: (report: RTCStatsReport) => boolean): Promise<void> {
    for (const link of this.links.values()) {
      try {
        if (isRelayed(await link.stats())) this.relayed.add(link.peerId);
        else this.relayed.delete(link.peerId);
      } catch {
        /* peer saindo */
      }
    }
    this.announce();
  }

  async collectStats(): Promise<RTCStatsReport[]> {
    // Enfileirado, nunca solto: dois `applyPreset` concorrentes no mesmo
    // sender foi o `InvalidStateError` da ADR 0006 A3.
    if (this.pendentes.size > 0) void this.enqueue(() => this.reaplicarPendentes());

    const reports: RTCStatsReport[] = [];
    for (const link of this.links.values()) {
      try {
        reports.push(await link.stats());
      } catch {
        /* peer saindo */
      }
    }
    return reports;
  }

  close(): void {
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.senders.clear();
    this.relayed.clear();
    this.waiting.clear();
    this.stream = null;
    this.tracks = [];
    this.emitter.clear();
  }

  private announce(): void {
    this.emitter.emit('peers', this.peers);
  }
}
