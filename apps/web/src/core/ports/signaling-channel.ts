import type { IceServerConfig, ServerMessage, SignalingErrorCode } from '@tela/shared';

/**
 * O canal de sinalização visto de dentro do núcleo.
 *
 * `core/` não sabe que existe WebSocket. Trocar o servidor de sinalização por
 * outro transporte — um broker gerenciado, um DataChannel de terceiros, um
 * arquivo em teste — é trocar o adapter, não a lógica.
 */
export type ChannelRole = 'host' | 'viewer';

export type ChannelOpened = {
  readonly role: ChannelRole;
  readonly selfId: string;
  /** Só existe para espectador: quem tem a mídia. */
  readonly hostId: string | null;
  readonly iceServers: readonly IceServerConfig[];
  /** Só existe para transmissor. */
  readonly maxPeers: number;
  /** Quantos já estavam assistindo quando entramos. Zero para o transmissor. */
  readonly viewers: number;
};

export type ChannelEvents = {
  /** Um espectador entrou (só o transmissor recebe). */
  'peer-joined': { peerId: string };
  'peer-left': { peerId: string };
  /** Quantos estão assistindo. Só o espectador recebe. */
  viewers: { count: number };
  /** Payload opaco vindo de outro peer. Quem interpreta é o PeerLink. */
  signal: { from: string; payload: unknown };
  closed: { reason: string };
  /**
   * O canal caiu e voltou sozinho, com a mesma reivindicação.
   *
   * Traz um `ChannelOpened` novo porque o servidor emite um `peerId` novo e,
   * mais importante, credenciais de TURN novas — as antigas expiram, e reusar
   * credencial vencida faz o próximo espectador falhar exatamente onde este
   * evento existe para consertar.
   */
  reopened: ChannelOpened;
};

export type SignalingError = { readonly code: SignalingErrorCode };

export type SignalingChannel = {
  /** Reivindica o canal como transmissor. Rejeita com `SignalingError`. */
  host(slug: string, ownerToken: string): Promise<ChannelOpened>;
  /** Entra como espectador. Rejeita com `SignalingError`. */
  watch(slug: string): Promise<ChannelOpened>;
  /** Envia payload opaco. `to` omitido = para o transmissor. */
  send(payload: unknown, to?: string): void;
  on<K extends keyof ChannelEvents>(
    event: K,
    handler: (payload: ChannelEvents[K]) => void,
  ): () => void;
  close(): void;
};

export type { ServerMessage };

export function isSignalingError(error: unknown): error is SignalingError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as SignalingError).code === 'string'
  );
}
