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

/** Alguém pede para entrar (ADR 0025). Só o transmissor recebe. */
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
  /** Só o espectador: o pedido está com o transmissor. */
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

export type SignalingError = {
  readonly code: SignalingErrorCode;
  /** Em `CHANNEL_FULL`, o teto da sala que recusou — para a tela dizer o número certo. */
  readonly maxPeers?: number | undefined;
};

/**
 * O que o transmissor declara ao reivindicar o canal.
 *
 * `capacidade` é quantos espectadores ele consegue servir. Não é o teto do
 * produto: um transmissor que codifica uma vez por peer para em poucos, e um
 * com "um encode, N envios" atende o teto inteiro. O servidor responde com o
 * `maxPeers` efetivo, e é esse que vale.
 */
export type OpcoesDeHost = { readonly capacidade?: number | undefined };

/** Quem pede para assistir. O link é só o nome do canal (ADR 0026). */
export type EntradaDeEspectador = {
  /** Como o transmissor vai ver quem pede (ADR 0025). */
  readonly nome: string;
  /** Segredo deste navegador; o transmissor só vê o hash dele. */
  readonly chave: string;
  readonly participantId?: string;
  readonly attemptId?: string;
};

export type SignalingChannel = {
  /** Reivindica o canal como transmissor. Rejeita com `SignalingError`. */
  host(slug: string, ownerToken: string, opcoes?: OpcoesDeHost): Promise<ChannelOpened>;
  /** Entra como espectador. Rejeita com `SignalingError`. */
  watch(slug: string, entrada: EntradaDeEspectador): Promise<ChannelOpened>;
  /** Tira um espectador, ou todos sem `peerId`. Não é banimento. */
  removeViewers(peerId?: string): void;
  /** Só o transmissor: aceita ou recusa um pedido de entrada. */
  responderPedido(peerId: string, aceitar: boolean): void;
  /**
   * Só o transmissor: quantos espectadores a banda dele paga agora (ADR 0030).
   * Opcional porque é fire-and-forget e nem todo canal precisa saber dela.
   */
  atualizarCapacidade?(valor: number): void;
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
