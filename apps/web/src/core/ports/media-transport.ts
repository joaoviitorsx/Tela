import type { Connection } from '@tela/shared';

/**
 * A fronteira que sustenta a Fase 3.
 *
 * `core/` inteiro fala com esta interface. Nenhuma menção a LiveKit, a
 * RTCPeerConnection ou a WebSocket aparece aqui — e é por isso que trocar o
 * transporte (LiveKit → P2P → WHIP no app nativo) não toca em
 * broadcast-session.ts nem em viewer-session.ts.
 *
 * Regra que faz isso valer alguma coisa (AGENTS.md R2): `livekit-client` só
 * pode ser importado dentro de `adapters/`. O lint quebra se escapar.
 */

export type QualityLimitation = 'none' | 'cpu' | 'bandwidth' | 'other';

export type TransportStats = {
  /** Framerate real de saída, medido — não o configurado. */
  readonly fps: number;
  /** Bits por segundo somados sobre tudo que está saindo (ou entrando). */
  readonly bitrateBps: number;
  readonly rttMs: number;
  /**
   * O campo mais útil do WebRTC. `cpu` significa que o encoder não dá conta
   * (provavelmente encode em software); `bandwidth`, que a rede não dá.
   * A UI mostra isso como diagnóstico honesto, não como número bonito.
   */
  readonly limitation: QualityLimitation;
  readonly width: number;
  readonly height: number;
};

export type PublisherEvents = {
  /** Quantos espectadores o transporte enxerga agora. */
  viewers: number;
  reconnecting: void;
  reconnected: void;
  /** Fim de linha: só chega quando não há mais reconexão possível. */
  closed: { reason: string };
};

export type ViewerEvents = {
  /** A mídia chegou e está no elemento de vídeo. */
  track: { hasAudio: boolean };
  reconnecting: void;
  reconnected: void;
  closed: { reason: string };
};

export type PublishRequest = {
  readonly video: MediaStreamTrack;
  readonly audio: MediaStreamTrack | null;
  readonly maxBitrate: number;
  readonly maxFramerate: number;
  readonly layers: readonly { width: number; height: number; maxBitrate: number; maxFramerate: number }[];
};

export type Unsubscribe = () => void;

export type PublisherTransport = {
  connect(connection: Connection): Promise<void>;
  publish(request: PublishRequest): Promise<void>;
  readStats(): Promise<TransportStats | null>;
  on<K extends keyof PublisherEvents>(
    event: K,
    handler: (payload: PublisherEvents[K]) => void,
  ): Unsubscribe;
  close(): Promise<void>;
};

export type ViewerTransport = {
  /** `sink` recebe o MediaStream pronto para virar `video.srcObject`. */
  connect(connection: Connection, sink: (stream: MediaStream) => void): Promise<void>;
  readStats(): Promise<TransportStats | null>;
  on<K extends keyof ViewerEvents>(
    event: K,
    handler: (payload: ViewerEvents[K]) => void,
  ): Unsubscribe;
  close(): Promise<void>;
};

/**
 * Escolhido em runtime pelo campo `transport` da resposta da API.
 *
 * Assíncrono de propósito: o adapter do LiveKit é carregado sob demanda. Quem
 * roda em modo P2P — o self-host doméstico — nunca baixa o SDK do LiveKit.
 */
export type TransportFactory = {
  publisher(kind: Connection['transport']): Promise<PublisherTransport>;
  viewer(kind: Connection['transport']): Promise<ViewerTransport>;
};
