import { DEGRADATION_PREFERENCE, type EncodingPreset, type IceServerConfig } from '@tela/shared';
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

  constructor(private readonly deps: MeshTopologyDeps) {}

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
    if (this.links.has(peerId)) this.drop(peerId); // reconexão do mesmo peer
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
      iceServers: this.deps.iceServers,
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

  /** Publica (ou republica) a mídia para todo mundo. */
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
      await this.adaptAll(preset);
    });
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
      if (sender.track?.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        const encodings = params.encodings?.length ? params.encodings : [{}];
        encodings[0] = {
          ...encodings[0],
          maxBitrate: preset.main.maxBitrate,
          maxFramerate: preset.main.maxFramerate,
        };
        await sender.setParameters({
          ...params,
          encodings,
          // Perder resolução, nunca framerate.
          degradationPreference: DEGRADATION_PREFERENCE,
        } as RTCRtpSendParameters);
      } catch {
        // Firefox ainda recusa `degradationPreference` em setParameters. O
        // encoding continua aplicado; não vale derrubar o peer por isso.
      }
    }
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
