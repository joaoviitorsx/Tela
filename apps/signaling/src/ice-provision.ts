import type { IceServerConfig } from '@tela/shared';
import { fetchCloudflareIceServers, type CloudflareTurnResult } from './cloudflare-turn.js';
import type { IceSettings } from './ice-settings.js';

export type IceProvisionResult = {
  servers: readonly IceServerConfig[];
  relayStatus: 'available' | 'not-configured' | 'unavailable';
  /** Epoch em milissegundos. Nunca enviar ao cliente sem política de renovação. */
  expiresAt?: number;
  /** Apenas para diagnóstico interno; o cliente recebe somente relayStatus. */
  failureCode?: 'TURN_TIMEOUT' | 'TURN_AUTH_FAILED' | 'TURN_RATE_LIMITED' |
    'TURN_RESPONSE_INVALID' | 'TURN_UPSTREAM_FAILED' | 'TURN_RELAY_ABSENT';
};

type FetchTurn = typeof fetchCloudflareIceServers;

/** Estado local ao provedor; não persiste segredos ou credenciais entre emissões. */
export function makeCloudflareProvider(
  settings: IceSettings,
  fetchTurn: FetchTurn = fetchCloudflareIceServers,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): () => Promise<IceProvisionResult> {
  let failures = 0;
  let openUntil = 0;
  let lastFailure: NonNullable<IceProvisionResult['failureCode']> = 'TURN_UPSTREAM_FAILED';

  return async () => {
    const stun: IceServerConfig = { urls: [...settings.stunUrls] };
    if (settings.cloudflareKeyId === undefined || settings.cloudflareToken === undefined) {
      return { servers: [stun], relayStatus: 'not-configured' };
    }
    if (now() < openUntil) {
      return { servers: [stun], relayStatus: 'unavailable', failureCode: lastFailure };
    }

    const started = now();
    let result: CloudflareTurnResult = await fetchTurn(
      settings.cloudflareKeyId,
      settings.cloudflareToken,
      settings.ttlSeconds,
      fetch,
      settings.fetchTimeoutMs,
    );
    if (!result.ok && (result.code === 'TURN_TIMEOUT' || result.code === 'TURN_UPSTREAM_FAILED')) {
      const beforeWait = 5000 - (now() - started) - 100;
      if (beforeWait >= 250) {
        await wait(100);
        const remaining = 5000 - (now() - started);
        if (remaining >= 250) {
          result = await fetchTurn(
            settings.cloudflareKeyId,
            settings.cloudflareToken,
            settings.ttlSeconds,
            fetch,
            Math.min(settings.fetchTimeoutMs, remaining),
          );
        }
      }
    }

    if (result.ok && result.hasRelay) {
      failures = 0;
      openUntil = 0;
      return {
        servers: [stun, ...result.servers],
        relayStatus: 'available',
        expiresAt: now() + settings.ttlSeconds * 1000,
      };
    }

    lastFailure = result.ok ? 'TURN_RELAY_ABSENT' : result.code;
    failures += 1;
    if (failures >= 3 || lastFailure === 'TURN_AUTH_FAILED' || lastFailure === 'TURN_RESPONSE_INVALID') {
      openUntil = now() + 30_000;
    }
    return {
      servers: result.ok ? [stun, ...result.servers] : [stun],
      relayStatus: 'unavailable',
      failureCode: lastFailure,
    };
  };
}
