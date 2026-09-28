import { createHmac, randomBytes } from 'node:crypto';
import type { IceServerConfig } from '@tela/shared';
import type { Config } from './config.js';
import type { IceProvisionResult } from './ice-provision.js';

/**
 * Credenciais de ICE entregues a cada peer.
 *
 * Credencial de TURN nunca vai no bundle do front — bundle é público, e uma
 * credencial pública de TURN é um relay aberto para a internet inteira, na
 * sua cota. O servidor entrega no momento em que ela é necessária.
 *
 * Com `TURN_SECRET`, o formato é o `use-auth-secret` do coturn (REST API,
 * RFC 7635): usuário = `<expiração>:<peer>`, senha = HMAC-SHA1 do usuário
 * com o segredo. O coturn valida sozinho, sem banco e sem chamada de volta,
 * e a credencial morre em minutos.
 */
export function makeIceProvider(config: Config): (peerId: string) => IceProvisionResult {
  const stun: IceServerConfig = { urls: [...config.ice.stunUrls] };

  return (peerId: string) => {
    const servers: IceServerConfig[] = [stun];

    if (config.ice.turnUrls.length > 0 && config.ice.turnSecret) {
      const expiry = Math.floor(Date.now() / 1000) + config.ice.ttlSeconds;
      const username = `${expiry}:${peerId}`;
      const credential = createHmac('sha1', config.ice.turnSecret)
        .update(username)
        .digest('base64');
      servers.push({ urls: [...config.ice.turnUrls], username, credential });
      return { servers, relayStatus: 'available', expiresAt: expiry * 1000 };
    }
    if (config.NODE_ENV !== 'production' && config.ice.staticUsername && config.ice.staticPassword) {
      servers.push({
        urls: [...config.ice.turnUrls],
        username: config.ice.staticUsername,
        credential: config.ice.staticPassword,
      });
      return { servers, relayStatus: 'available' };
    }

    return { servers, relayStatus: 'not-configured' };
  };
}

/** Identidade de peer: curta para caber em log, imprevisível dentro do canal. */
export function makePeerIdGenerator(): (prefix: string) => string {
  const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
  return (prefix: string) => {
    let out = '';
    for (const byte of randomBytes(8)) out += ALPHABET[byte % ALPHABET.length];
    return `${prefix}_${out}`;
  };
}
