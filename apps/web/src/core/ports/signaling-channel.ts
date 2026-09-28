import type { IceServerConfig, RelayStatus, ServerMessage, SignalingErrorCode } from '@tela/shared';

/**
 * O canal de sinalização visto de dentro do núcleo.
 *
 * `core/` não sabe que existe WebSocket. Trocar o servidor de sinalização por
 * outro transporte — um broker gerenciado, um DataChannel de terceiros, um
 * arquivo em teste — é trocar o adapter, não a lógica.
 */
export type ChannelRole = 'host' | 'viewer';

export type IceCredentials = {
  readonly iceServers: readonly IceServerConfig[];
  readonly relayStatus?: RelayStatus;
  readonly issuedAt?: number | undefined;
  readonly expiresAt?: number | undefined;
};

export type ChannelOpened = IceCredentials & {
  readonly role: ChannelRole;
  readonly selfId: string;
  /** Só existe para espectador: quem tem a mídia. */
  readonly hostId: string | null;
  /** Só existe para transmissor. */
  readonly maxPeers: number;
  /** Quantos já estavam assistindo quando entramos. Zero para o transmissor. */
  readonly viewers: number;
};

/** Alguém com o convite pede para entrar (ADR 0025). Só o transmissor recebe. */
export type PedidoDeEntrada = {
  readonly peerId: string;
  readonly nome: string;
  /** sha256 da chave do navegador de quem pede, calculado pelo servidor. */
  readonly impressao: string;
};

export type ChannelEvents = {
  /** Um espectador entrou (só o transmissor recebe). */
  'peer-joined': {
    peerId: string;
    attemptId?: string | undefined;
    nome?: string | undefined;
    impressao?: string | undefined;
  };
  /** Só o transmissor: pedido novo, ou reapresentado depois de reconectar. */
  'pedido': PedidoDeEntrada;
  /** Só o transmissor: quem pedia desistiu ou caiu antes da resposta. */
  'pedido-cancelado': { peerId: string };
  /** Só o espectador: convite aceito, o pedido está com o transmissor. */
  'aguardando-aprovacao': void;
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

/** `invite` é o segredo do link; o servidor guarda só o hash dele. */
export type EntradaDeEspectador = {
  readonly invite: string;
  /** Como o transmissor vai ver quem pede (ADR 0025). */
  readonly nome: string;
  /** Segredo deste navegador; o transmissor só vê o hash dele. */
  readonly chave: string;
  readonly participantId?: string;
  readonly attemptId?: string;
};

export type SignalingChannel = {
  /** Reivindica o canal como transmissor. Rejeita com `SignalingError`. */
  host(slug: string, ownerToken: string, invite: string): Promise<ChannelOpened>;
  /** Entra como espectador. Rejeita com `SignalingError`. */
  watch(slug: string, entrada: EntradaDeEspectador): Promise<ChannelOpened>;
  /**
   * Troca o convite do canal (TELA-018). Resolve quando o servidor confirmou:
   * a partir daí só o convite novo entra. Quem já está dentro fica.
   */
  setInvite(invite: string): Promise<void>;
  /** Tira um espectador, ou todos sem `peerId`. Não é banimento. */
  removeViewers(peerId?: string): void;
  /** Só o transmissor: aceita ou recusa um pedido de entrada. */
  responderPedido(peerId: string, aceitar: boolean): void;
  /** Renova credenciais do mesmo participante sem abrir outro socket. */
  refreshIce(): Promise<IceCredentials>;
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
