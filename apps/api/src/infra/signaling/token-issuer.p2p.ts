import type { Connection } from '@tela/shared';
import {
  PUBLISHER_TOKEN_TTL_SECONDS,
  VIEWER_TOKEN_TTL_SECONDS,
} from '../../domain/broadcast.js';
import type { TokenIssuer } from '../../ports/token-issuer.js';
import { issueTicket } from './ticket.js';

export type P2pTokenDeps = {
  secret: string;
  /** URL pública do WebSocket de sinalização entregue ao browser. */
  signalUrl: string;
  iceServers: readonly { urls: string[]; username?: string; credential?: string }[];
  maxViewers: number;
  now: () => number;
};

/**
 * Mesmo contrato do emissor do LiveKit, outro transporte.
 *
 * Repare no que NÃO está aqui: nenhuma noção de sala no servidor de mídia,
 * porque não existe servidor de mídia. O que o cliente recebe é o endereço do
 * hub, um ticket assinado e a lista de servidores ICE.
 */
export function makeP2pTokenIssuer(deps: P2pTokenDeps): TokenIssuer {
  const ttl = (seconds: number) => Math.floor(deps.now() / 1000) + seconds;

  return {
    async forPublisher(room, identity): Promise<Connection> {
      return {
        transport: 'p2p',
        ticket: issueTicket(deps.secret, {
          room,
          identity,
          role: 'publisher',
          exp: ttl(PUBLISHER_TOKEN_TTL_SECONDS),
        }),
        signalUrl: deps.signalUrl,
        room,
        iceServers: deps.iceServers.map((s) => ({ ...s })),
        maxViewers: deps.maxViewers,
      };
    },

    async forViewer(room, identity): Promise<Connection> {
      return {
        transport: 'p2p',
        ticket: issueTicket(deps.secret, {
          room,
          identity,
          role: 'viewer',
          exp: ttl(VIEWER_TOKEN_TTL_SECONDS),
        }),
        signalUrl: deps.signalUrl,
        room,
        iceServers: deps.iceServers.map((s) => ({ ...s })),
        maxViewers: deps.maxViewers,
      };
    },
  };
}
