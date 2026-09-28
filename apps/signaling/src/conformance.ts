import { PROTOCOL_VERSION, type ServerMessage } from '@tela/shared';

/**
 * Contrato de comportamento do servidor de sinalização, independente de onde
 * ele roda.
 *
 * Existem duas implementações — Node com `ws` e Cloudflare Durable Objects —
 * porque o modelo de estado é genuinamente diferente sob hibernação (ver o
 * cabeçalho de `worker.ts`). Duas implementações do mesmo protocolo divergem
 * em silêncio se ninguém segurar; esta suíte é quem segura.
 *
 * As expectativas aqui são as que um CLIENTE consegue observar. Nada sobre
 * estrutura interna: o ponto é justamente que as estruturas internas diferem.
 */
export type ConformanceClient = {
  readonly id: string;
  /** Tudo que o servidor mandou para este cliente, em ordem. */
  received(): ServerMessage[];
  last(): ServerMessage | undefined;
  closed(): boolean;
};

/**
 * O que acompanha a saudação. Padrão: versão atual e o `CONVITE` da suíte.
 * `null` OMITE o campo — é assim que se simula cliente antigo ou link sem
 * convite.
 */
export type Saudacao = {
  readonly invite?: string | null;
  readonly protocol?: number | null;
};

export type ConformanceDriver = {
  /** Abre uma conexão e envia `host`. */
  host(id: string, slug: string, ownerToken: string, saudacao?: Saudacao): Promise<ConformanceClient>;
  /** Abre uma conexão e envia `watch`. */
  watch(
    id: string, slug: string, identity?: { participantId: string; attemptId: string },
    saudacao?: Saudacao,
  ): Promise<ConformanceClient>;
  /** Envia uma mensagem qualquer por uma conexão já aberta. */
  send(id: string, message: unknown): Promise<void>;
  refreshIce(id: string, requestId: string): Promise<void>;
  /** Envia `signal` por uma conexão já aberta. */
  signal(id: string, payload: unknown, to?: string): Promise<void>;
  /**
   * Envia `leave` — saída ANUNCIADA, diferente de queda de socket.
   *
   * A distinção é comportamento observável: saída anunciada derruba a plateia
   * na hora; socket que cai deixa a plateia em paz, porque a mídia é direta e
   * pode continuar.
   */
  leave(id: string): Promise<void>;
  /** Fecha a conexão como o transporte faria. */
  disconnect(id: string): void;
  /**
   * Simula a hibernação da plataforma, quando ela existe.
   *
   * Só o Durable Object hiberna. No servidor Node não há o que simular, e a
   * ausência do gancho é o que diz isso — em vez de um teste que finge
   * cobrir um caminho que não existe ali.
   */
  hibernar?(): void;
};

export const OWNER = 'o'.repeat(43);
export const OUTRO = 'z'.repeat(43);
export const SLUG = 'joao';
export const CONVITE = 'c'.repeat(22);
export const OUTRO_CONVITE = 'd'.repeat(22);

/** Monta `host`/`watch` com os campos da versão atual, salvo omissão explícita. */
export function saudar(
  base: Record<string, unknown>,
  saudacao: Saudacao = {},
): Record<string, unknown> {
  const invite = saudacao.invite === undefined ? CONVITE : saudacao.invite;
  const protocol = saudacao.protocol === undefined ? PROTOCOL_VERSION : saudacao.protocol;
  return {
    ...base,
    ...(invite === null ? {} : { invite }),
    ...(protocol === null ? {} : { protocol }),
  };
}

export function peerIdOf(client: ConformanceClient): string {
  const first = client.received()[0];
  if (first?.type === 'hosting' || first?.type === 'watching') return first.peerId;
  throw new Error(`cliente ${client.id} não entrou no canal: ${JSON.stringify(first)}`);
}

export function errorOf(client: ConformanceClient): string | undefined {
  return client.received().find((m) => m.type === 'error')?.code;
}

export function ofType<T extends ServerMessage['type']>(
  client: ConformanceClient,
  type: T,
): Extract<ServerMessage, { type: T }>[] {
  return client
    .received()
    .filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}
