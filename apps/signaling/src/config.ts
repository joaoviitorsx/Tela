import { z } from 'zod';
import { DEFAULT_LIMITS, type Limits } from './limits.js';

/** ÚNICO lugar do serviço que lê process.env. */
const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  /** Origens permitidas no handshake do WebSocket. Vazio = qualquer uma. */
  ALLOWED_ORIGINS: z.string().default(''),

  MAX_PEERS: z.coerce.number().int().min(1).max(8).default(DEFAULT_LIMITS.maxPeers),

  STUN_URLS: z.string().default('stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478'),
  /**
   * TURN com credencial estática. Só use em desenvolvimento — em produção
   * prefira `TURN_SECRET`, que gera credencial efêmera por peer.
   */
  TURN_URL: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_PASSWORD: z.string().optional(),
  /**
   * Segredo compartilhado com o coturn (`use-auth-secret`). Com ele, cada peer
   * recebe usuário e senha derivados por HMAC, válidos por poucos minutos —
   * credencial vazada de um espectador não vira relay aberto para o mundo.
   */
  TURN_SECRET: z.string().optional(),
  TURN_TTL_SECONDS: z.coerce.number().int().min(60).default(600),
});

export type Config = z.infer<typeof Schema> & {
  readonly limits: Limits;
  readonly allowedOrigins: readonly string[];
  readonly stunUrls: readonly string[];
};

export function parseConfig(env: NodeJS.ProcessEnv): { config: Config } | { problems: string[] } {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`),
    };
  }
  const raw = parsed.data;
  const problems: string[] = [];

  const usaEstatico = Boolean(raw.TURN_URL && raw.TURN_USERNAME && raw.TURN_PASSWORD);
  if (raw.NODE_ENV === 'production' && usaEstatico && !raw.TURN_SECRET) {
    problems.push(
      'TURN com credencial estática em produção: qualquer espectador que abrir o DevTools ganha um relay permanente. Use TURN_SECRET.',
    );
  }
  if (problems.length > 0) return { problems };

  const split = (value: string) =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  return {
    config: {
      ...raw,
      limits: { ...DEFAULT_LIMITS, maxPeers: raw.MAX_PEERS },
      allowedOrigins: split(raw.ALLOWED_ORIGINS),
      stunUrls: split(raw.STUN_URLS),
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = parseConfig(env);
  if ('problems' in result) {
    for (const p of result.problems) console.error(`[config] ${p}`);
    process.exit(1);
  }
  return result.config;
}
