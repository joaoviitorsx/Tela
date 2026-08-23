import { AccessToken } from 'livekit-server-sdk';
import type { Connection } from '@tela/shared';
import {
  PUBLISHER_TOKEN_TTL_SECONDS,
  VIEWER_TOKEN_TTL_SECONDS,
} from '../../domain/broadcast.js';
import type { TokenIssuer } from '../../ports/token-issuer.js';

export type LiveKitTokenDeps = {
  apiKey: string;
  apiSecret: string;
  /** URL pública entregue ao browser — atrás do Caddy costuma ser wss://dominio/rtc. */
  wsUrl: string;
};

export function makeLiveKitTokenIssuer(deps: LiveKitTokenDeps): TokenIssuer {
  return {
    async forPublisher(room, identity): Promise<Connection> {
      const at = new AccessToken(deps.apiKey, deps.apiSecret, {
        identity,
        ttl: PUBLISHER_TOKEN_TTL_SECONDS,
        metadata: JSON.stringify({ role: 'publisher' }),
      });
      at.addGrant({
        room,
        roomJoin: true,
        roomCreate: false, // só a API cria sala; auto_create fica false no SFU
        canPublish: true,
        // O transmissor não precisa receber nada. Por padrão o SDK inscreve
        // todo mundo em todo mundo — isso gastaria download durante o jogo.
        canSubscribe: false,
        canPublishData: true,
      });
      return { transport: 'sfu', token: await at.toJwt(), wsUrl: deps.wsUrl, room };
    },

    async forViewer(room, identity): Promise<Connection> {
      const at = new AccessToken(deps.apiKey, deps.apiSecret, {
        identity,
        ttl: VIEWER_TOKEN_TTL_SECONDS,
      });
      at.addGrant({
        room,
        roomJoin: true,
        canPublish: false, // espectador virando publisher é barrado pelo próprio SFU
        canSubscribe: true,
        canPublishData: false, // sem chat, sem canal de dados (R6)
        canUpdateOwnMetadata: false,
      });
      return { transport: 'sfu', token: await at.toJwt(), wsUrl: deps.wsUrl, room };
    },
  };
}
