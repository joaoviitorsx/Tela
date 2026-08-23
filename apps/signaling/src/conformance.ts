import type { ServerMessage } from '@tela/shared';

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

export type ConformanceDriver = {
  /** Abre uma conexão e envia `host`. */
  host(id: string, slug: string, ownerToken: string): Promise<ConformanceClient>;
  /** Abre uma conexão e envia `watch`. */
  watch(id: string, slug: string): Promise<ConformanceClient>;
  /** Envia `signal` por uma conexão já aberta. */
  signal(id: string, payload: unknown, to?: string): Promise<void>;
  /** Fecha a conexão como o transporte faria. */
  disconnect(id: string): void;
};

export const OWNER = 'o'.repeat(43);
export const OUTRO = 'z'.repeat(43);
export const SLUG = 'joao';

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
