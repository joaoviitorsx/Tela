import { z } from 'zod';
import type { IceServerConfig } from '@tela/shared';

const IceUrlSchema = z.string().min(1).max(2048).refine((value) => {
  const match = /^(stun|stuns|turn|turns):(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(value);
  if (match === null) return false;
  if (match[2] !== undefined && (Number(match[2]) === 0 || Number(match[2]) > 65535)) return false;
  return match[3] === undefined || /^turns?$/i.test(match[1] ?? '');
});

const IceEntrySchema = z.object({
  urls: z.union([IceUrlSchema, z.array(IceUrlSchema).min(1).max(8)]),
  username: z.string().min(1).max(512).refine((value) => value.trim().length > 0).optional(),
  credential: z.string().min(1).max(512).refine((value) => value.trim().length > 0).optional(),
});

const IceResponseSchema = z.object({
  iceServers: z.union([IceEntrySchema, z.array(IceEntrySchema).min(1).max(8)]),
});

export type ParsedIceServers = {
  servers: IceServerConfig[];
  hasRelay: boolean;
};

/** Rejeita a resposta inteira se uma entrada for inválida: não envia ICE parcial. */
export function parseCloudflareIceServers(input: unknown): ParsedIceServers | null {
  const parsed = IceResponseSchema.safeParse(input);
  if (!parsed.success) return null;

  const entries = Array.isArray(parsed.data.iceServers)
    ? parsed.data.iceServers
    : [parsed.data.iceServers];
  let hasRelay = false;
  for (const entry of entries) {
    const urls = typeof entry.urls === 'string' ? [entry.urls] : entry.urls;
    if (urls.some((url) => /^turns?:/i.test(url))) {
      if (entry.username === undefined || entry.credential === undefined) return null;
      hasRelay = true;
    }
  }
  return { servers: entries, hasRelay };
}

export type CloudflareTurnResult =
  | ({ ok: true } & ParsedIceServers)
  | { ok: false; code: 'TURN_RESPONSE_INVALID' | 'TURN_AUTH_FAILED' | 'TURN_RATE_LIMITED' | 'TURN_UPSTREAM_FAILED' | 'TURN_TIMEOUT' };

/** Endpoint e forma da resposta pertencem ao mesmo contrato da API. */
export async function fetchCloudflareIceServers(
  keyId: string,
  token: string,
  ttl: number,
  request: typeof fetch = fetch,
): Promise<CloudflareTurnResult> {
  try {
    const response = await request(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(2500),
      },
    );
    if (response.status === 401 || response.status === 403) return { ok: false, code: 'TURN_AUTH_FAILED' };
    if (response.status === 429) return { ok: false, code: 'TURN_RATE_LIMITED' };
    if (!response.ok) return { ok: false, code: 'TURN_UPSTREAM_FAILED' };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, code: 'TURN_RESPONSE_INVALID' };
    }
    const parsed = parseCloudflareIceServers(body);
    return parsed === null ? { ok: false, code: 'TURN_RESPONSE_INVALID' } : { ok: true, ...parsed };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { ok: false, code: name === 'AbortError' || name === 'TimeoutError' ? 'TURN_TIMEOUT' : 'TURN_UPSTREAM_FAILED' };
  }
}
