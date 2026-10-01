import type { ServerMessage } from '@tela/shared';
import { type Connection, makeChannelRegistry } from './channel-registry.js';
import { type ConformanceClient, type ConformanceDriver, TETO_DE_TESTE, saudar } from './conformance.js';
import { SpySocket, TestClock, testDeps } from './testing.js';

/** Driver de conformidade sobre o registro em memória (Node + `ws`). */
export function makeNodeDriver(opcoes: { readonly maxPeers?: number } = {}): ConformanceDriver {
  const clock = new TestClock();
  const registry = makeChannelRegistry(testDeps(clock, { maxPeers: opcoes.maxPeers ?? TETO_DE_TESTE }));
  const sockets = new Map<string, SpySocket>();
  const conns = new Map<string, Connection>();

  const client = (id: string): ConformanceClient => ({
    id,
    received: () => sockets.get(id)?.sent ?? [],
    last: () => sockets.get(id)?.last(),
    closed: () => sockets.get(id)?.closed ?? false,
  });

  function open(id: string, message: unknown, ip: string): ConformanceClient {
    const socket = new SpySocket();
    sockets.set(id, socket);
    // Um IP distinto por cliente: o limite de `host` por IP é do servidor, não
    // do contrato de protocolo que esta suíte verifica.
    const conn = registry.accept(socket, `${ip}.${sockets.size}`);
    conns.set(id, conn);
    conn.receive(JSON.stringify(message));
    return client(id);
  }

  return {
    async host(id, slug, ownerToken, saudacao) {
      return open(id, saudar({ type: 'host', slug, ownerToken }, saudacao), '10.0.0');
    },
    async watch(id, slug, identity, saudacao) {
      return open(id, saudar({ type: 'watch', slug, ...identity }, saudacao, id), '10.0.1');
    },
    async send(id, message) {
      conns.get(id)?.receive(JSON.stringify(message));
    },
    async refreshIce(id, requestId) {
      conns.get(id)?.receive(JSON.stringify({ type: 'refresh-ice', requestId }));
    },
    async signal(id, payload, to) {
      conns.get(id)?.receive(
        JSON.stringify(to === undefined ? { type: 'signal', payload } : { type: 'signal', to, payload }),
      );
    },
    async leave(id) {
      conns.get(id)?.receive(JSON.stringify({ type: 'leave' }));
    },
    disconnect(id) {
      conns.get(id)?.disconnect();
    },
  };
}

export type { ServerMessage };
