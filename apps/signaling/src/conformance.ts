import { PROTOCOL_VERSION, type ServerMessage } from '@tela/shared';
import type { Limits } from './limits.js';

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
 * O que acompanha a saudação. Padrão: versão atual. `null` OMITE o campo — é
 * assim que se simula cliente antigo.
 */
export type Saudacao = {
  readonly protocol?: number | null;
  /** Só `host`: sala com aprovação (ADR 0025). Padrão: aberta (ADR 0028). */
  readonly approval?: boolean;
  /**
   * Só `host`: quantos espectadores o transmissor aguenta (ADR 0029). Padrão:
   * omitido, que é o teto do servidor. Qualquer valor atravessa — é assim que
   * se testa a recusa dos inválidos.
   */
  readonly capacidade?: unknown;
  /** Só `watch`. Padrão: o id do cliente. `null` omite. */
  readonly name?: string | null;
  /** Só `watch`. Padrão: derivada do id do cliente. `null` omite. */
  readonly viewerKey?: string | null;
  /**
   * Só `watch`: o transmissor aceita o pedido na hora (padrão). `false` deixa
   * o pedido esperando — é assim que se testa a aprovação em si (ADR 0025).
   */
  readonly aprovar?: boolean;
  /**
   * Origem de rede da conexão (IP). Não vai na mensagem: é o que o servidor
   * enxerga do socket. Padrão: um IP distinto por cliente no Node (os limites
   * por IP não interferem nos cenários de protocolo) e NENHUM no Worker (que
   * então não aplica limite por IP). Os testes de abuso passam o mesmo IP.
   */
  readonly ip?: string;
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
  /**
   * Avança o relógio da CARÊNCIA de posse (ADR 0037): o tempo que o canal
   * guarda o dono depois que o transmissor sai. É o único jeito de exercitar
   * a TOMADA do slug por outra pessoa DEPOIS dos cinco minutos sem esperar o
   * tempo real passar. As duas implementações o oferecem.
   */
  avancar?(ms: number): void;
};

export const OWNER = 'o'.repeat(43);
export const OUTRO = 'z'.repeat(43);
export const SLUG = 'joao';
/** Opções dos drivers: teto do servidor e limites sobrepostos (para estourar um limite barato). */
export type OpcoesDoDriver = { readonly maxPeers?: number; readonly limites?: Partial<Limits> };
/** Teto do servidor nos drivers: pequeno para o "canal cheio" ser barato de encher. */
export const TETO_DE_TESTE = 3;

/** Monta `host`/`watch` com os campos da versão atual, salvo omissão explícita. */
export function saudar(
  base: Record<string, unknown>,
  saudacao: Saudacao = {},
  id = 'espectador',
): Record<string, unknown> {
  const protocol = saudacao.protocol === undefined ? PROTOCOL_VERSION : saudacao.protocol;
  const assiste = base['type'] === 'watch';
  const name = saudacao.name === undefined ? id : saudacao.name;
  const viewerKey = saudacao.viewerKey === undefined ? chaveDe(id) : saudacao.viewerKey;
  return {
    ...base,
    ...(protocol === null ? {} : { protocol }),
    ...(base['type'] === 'host' && saudacao.approval !== undefined ? { approval: saudacao.approval } : {}),
    ...(base['type'] === 'host' && saudacao.capacidade !== undefined ? { capacidade: saudacao.capacidade } : {}),
    ...(assiste && name !== null ? { name } : {}),
    ...(assiste && viewerKey !== null ? { viewerKey } : {}),
  };
}

/** Chave de navegador estável por cliente de teste: mesmo id, mesmo navegador. */
export function chaveDe(id: string): string {
  return `k${id.replace(/[^A-Za-z0-9_-]/g, '_')}`.padEnd(22, 'k');
}

/**
 * Envolve um driver para que todo `watch` seja aceito pelo transmissor, como
 * era antes da aprovação manual (ADR 0025). Os cenários antigos continuam
 * dizendo o que diziam; os de aprovação pedem `aprovar: false`.
 */
export function comAprovacao(driver: ConformanceDriver): ConformanceDriver {
  const hosts: ConformanceClient[] = [];
  return {
    ...driver,
    async host(id, slug, ownerToken, saudacao) {
      const host = await driver.host(id, slug, ownerToken, saudacao);
      hosts.push(host);
      return host;
    },
    async watch(id, slug, identity, saudacao) {
      const viewer = await driver.watch(id, slug, identity, saudacao);
      if (saudacao?.aprovar === false) return viewer;
      if (!viewer.received().some((m) => m.type === 'awaiting-approval')) return viewer;
      const name = saudacao?.name ?? id;
      // O host mais recente que recebeu este pedido é quem responde.
      for (const host of [...hosts].reverse()) {
        const pedido = host.received()
          .filter((m): m is Extract<ServerMessage, { type: 'join-request' }> => m.type === 'join-request')
          .reverse()
          .find((m) => m.name === name);
        if (pedido === undefined || host.closed()) continue;
        await driver.send(host.id, { type: 'admit', peerId: pedido.peerId });
        break;
      }
      return viewer;
    },
  };
}

export function peerIdOf(client: ConformanceClient): string {
  const entrada = client.received().find((m) => m.type === 'hosting' || m.type === 'watching');
  if (entrada?.type === 'hosting' || entrada?.type === 'watching') return entrada.peerId;
  throw new Error(`cliente ${client.id} não entrou no canal: ${JSON.stringify(client.received()[0])}`);
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
