import { isStunUrl, isTurnUrl } from './cloudflare-turn.js';

export type IceSettingsInput = {
  ICE_PROVIDER?: string | undefined;
  STUN_URLS?: string | undefined;
  TURN_URL?: string | undefined;
  TURN_URLS?: string | undefined;
  TURN_SECRET?: string | undefined;
  TURN_USERNAME?: string | undefined;
  TURN_PASSWORD?: string | undefined;
  TURN_KEY_ID?: string | undefined;
  TURN_KEY_API_TOKEN?: string | undefined;
  TURN_TTL_SECONDS?: string | undefined;
  TURN_FETCH_TIMEOUT_MS?: string | undefined;
};

export type IceSettings = {
  provider: 'auto' | 'cloudflare' | 'coturn';
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  turnSecret?: string;
  staticUsername?: string;
  staticPassword?: string;
  cloudflareKeyId?: string;
  cloudflareToken?: string;
  ttlSeconds: number;
  fetchTimeoutMs: number;
};

const DEFAULT_STUN = 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478';

const split = (value: string): string[] => value.split(',').map((item) => item.trim());

/** Códigos fixos: diagnóstico de configuração nunca contém valores de secrets. */
export function parseIceSettings(input: IceSettingsInput):
  | { settings: IceSettings }
  | { problems: string[] } {
  const problems: string[] = [];
  const provider = input.ICE_PROVIDER ?? 'auto';
  if (provider !== 'auto' && provider !== 'cloudflare' && provider !== 'coturn') {
    problems.push('ICE_PROVIDER_INVALID');
  }

  const stunUrls = split(input.STUN_URLS ?? DEFAULT_STUN);
  if (stunUrls.length === 0 || stunUrls.length > 8 || stunUrls.some((url) => !isStunUrl(url))) {
    problems.push('STUN_URLS_INVALID');
  }

  if (input.TURN_URL !== undefined && input.TURN_URLS !== undefined) problems.push('TURN_URLS_AMBIGUOUS');
  const turnRaw = input.TURN_URLS ?? input.TURN_URL;
  const turnUrls = turnRaw === undefined ? [] : split(turnRaw);
  if (turnUrls.length > 8 || turnUrls.some((url) => !isTurnUrl(url))) problems.push('TURN_URLS_INVALID');
  const hasCoturnSecret = Boolean(input.TURN_SECRET?.trim());
  const hasStaticUser = Boolean(input.TURN_USERNAME?.trim());
  const hasStaticPassword = Boolean(input.TURN_PASSWORD?.trim());
  const hasStatic = hasStaticUser && hasStaticPassword;
  if (hasStaticUser !== hasStaticPassword) problems.push('STATIC_TURN_CONFIG_INCOMPLETE');
  if ((hasCoturnSecret || hasStatic) !== (turnUrls.length > 0)) problems.push('COTURN_CONFIG_INCOMPLETE');
  if (input.TURN_SECRET !== undefined && !hasCoturnSecret) problems.push('TURN_SECRET_EMPTY');
  if (input.TURN_USERNAME !== undefined && !hasStaticUser) problems.push('TURN_USERNAME_EMPTY');
  if (input.TURN_PASSWORD !== undefined && !hasStaticPassword) problems.push('TURN_PASSWORD_EMPTY');

  const hasCloudflareId = Boolean(input.TURN_KEY_ID?.trim());
  const hasCloudflareToken = Boolean(input.TURN_KEY_API_TOKEN?.trim());
  if (hasCloudflareId !== hasCloudflareToken) problems.push('CLOUDFLARE_CONFIG_INCOMPLETE');
  if (input.TURN_KEY_ID !== undefined && !hasCloudflareId) problems.push('TURN_KEY_ID_EMPTY');
  if (input.TURN_KEY_API_TOKEN !== undefined && !hasCloudflareToken) problems.push('TURN_KEY_API_TOKEN_EMPTY');
  if (provider === 'cloudflare' && !hasCloudflareId) problems.push('CLOUDFLARE_NOT_CONFIGURED');
  if (provider === 'coturn' && !hasCoturnSecret && !hasStatic) problems.push('COTURN_NOT_CONFIGURED');

  const ttlSeconds = Number(input.TURN_TTL_SECONDS ?? '600');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) problems.push('TURN_TTL_SECONDS_INVALID');
  const fetchTimeoutMs = Number(input.TURN_FETCH_TIMEOUT_MS ?? '2500');
  if (!Number.isInteger(fetchTimeoutMs) || fetchTimeoutMs < 250 || fetchTimeoutMs > 5000) {
    problems.push('TURN_FETCH_TIMEOUT_MS_INVALID');
  }
  if (problems.length > 0) return { problems };

  return {
    settings: {
      provider: provider as IceSettings['provider'],
      stunUrls,
      turnUrls,
      // `.trim()`: a validação acima já usa o valor aparado, e um `\n` colado no
      // fim do secret passava como válido e virava `keys/abc%0A` na URL (404,
      // relay fora do ar em silêncio).
      ...(hasCoturnSecret && input.TURN_SECRET !== undefined ? { turnSecret: input.TURN_SECRET.trim() } : {}),
      ...(hasStatic && input.TURN_USERNAME !== undefined && input.TURN_PASSWORD !== undefined
        ? { staticUsername: input.TURN_USERNAME.trim(), staticPassword: input.TURN_PASSWORD.trim() } : {}),
      ...(hasCloudflareId && input.TURN_KEY_ID !== undefined && input.TURN_KEY_API_TOKEN !== undefined
        ? { cloudflareKeyId: input.TURN_KEY_ID.trim(), cloudflareToken: input.TURN_KEY_API_TOKEN.trim() } : {}),
      ttlSeconds,
      fetchTimeoutMs,
    },
  };
}

export function describeIceSettings(settings: IceSettings): {
  provider: IceSettings['provider'];
  cloudflareConfigured: boolean;
  coturnConfigured: boolean;
  /** `segredo`: credencial derivada que expira; `estatico`: usuário e senha fixos. */
  coturnModo: 'segredo' | 'estatico' | null;
  stunUrls: number;
  turnUrls: number;
  fetchTimeoutMs: number;
  ttlSeconds: number;
} {
  return {
    provider: settings.provider,
    cloudflareConfigured: settings.cloudflareKeyId !== undefined,
    coturnConfigured: settings.turnSecret !== undefined || settings.staticUsername !== undefined,
    coturnModo: settings.turnSecret !== undefined ? 'segredo' : settings.staticUsername !== undefined ? 'estatico' : null,
    stunUrls: settings.stunUrls.length,
    turnUrls: settings.turnUrls.length,
    fetchTimeoutMs: settings.fetchTimeoutMs,
    ttlSeconds: settings.ttlSeconds,
  };
}
