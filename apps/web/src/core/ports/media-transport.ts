import type { EncodingPreset } from '@tela/shared';
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
};

export type TransportEvents = {
  /** Estado da malha mudou: entrou, saiu, ou o caminho virou relay. */
  peers: readonly PeerInfo[];
  /** Só no espectador: a mídia chegou. */
  track: { stream: MediaStream };
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
  /** A mídia acabou. Aí sim é fim. */
  closed: { reason: string };
};

export type Unsubscribe = () => void;

export type MediaTransport = {
  /** Reivindica o canal e passa a esperar espectadores. */
  host(slug: string, ownerToken: string): Promise<void>;
  /** Entra num canal como espectador. */
  watch(slug: string): Promise<void>;

  publishVideo(track: MediaStreamTrack, preset: EncodingPreset): Promise<void>;
  publishAudio(track: MediaStreamTrack): Promise<void>;
  /** Troca de qualidade sem renegociar: `setParameters` nos senders. */
  setPreset(preset: EncodingPreset): Promise<void>;
  /**
   * Teto duro de upload, abaixo do preset. `null` remove.
   *
   * O preset diz o que o usuário quer; o teto diz o que o link aguenta sem
   * estrangular o jogo. Vence o menor dos dois.
   */
  setBitrateCeiling(bps: number | null): Promise<void>;

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
