import { createHmac, randomBytes } from 'node:crypto';
import type { IceServerConfig } from '@tela/shared';
import type { Config } from './config.js';

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
export function makeIceProvider(config: Config): (peerId: string) => IceServerConfig[] {
  const stun: IceServerConfig = { urls: [...config.stunUrls] };

  return (peerId: string) => {
    const servers: IceServerConfig[] = [stun];

    if (config.TURN_URL && config.TURN_SECRET) {
      const expiry = Math.floor(Date.now() / 1000) + config.TURN_TTL_SECONDS;
      const username = `${expiry}:${peerId}`;
      const credential = createHmac('sha1', config.TURN_SECRET)
        .update(username)
        .digest('base64');
      servers.push({ urls: [config.TURN_URL], username, credential });
    } else if (config.TURN_URL && config.TURN_USERNAME && config.TURN_PASSWORD) {
      servers.push({
        urls: [config.TURN_URL],
        username: config.TURN_USERNAME,
        credential: config.TURN_PASSWORD,
      });
    }

    return servers;
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
