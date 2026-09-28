import { z } from 'zod';
import { DEFAULT_LIMITS, type Limits } from './limits.js';
import { parseIceSettings, type IceSettings } from './ice-settings.js';

/** ÚNICO lugar do serviço que lê process.env. */
const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  /** Origens permitidas no handshake do WebSocket. Vazio = qualquer uma. */
  ALLOWED_ORIGINS: z.string().default(''),

  MAX_PEERS: z.coerce.number().int().min(1).max(8).default(DEFAULT_LIMITS.maxPeers),

  STUN_URLS: z.string().default('stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478'),
  ICE_PROVIDER: z.string().optional(),
  /**
   * TURN com credencial estática. Só use em desenvolvimento — em produção
   * prefira `TURN_SECRET`, que gera credencial efêmera por peer.
   */
  TURN_URL: z.string().optional(),
  TURN_URLS: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_PASSWORD: z.string().optional(),
  /**
   * Segredo compartilhado com o coturn (`use-auth-secret`). Com ele, cada peer
   * recebe usuário e senha derivados por HMAC, válidos por poucos minutos —
   * credencial vazada de um espectador não vira relay aberto para o mundo.
   */
  TURN_SECRET: z.string().optional(),
  TURN_KEY_ID: z.string().optional(),
  TURN_KEY_API_TOKEN: z.string().optional(),
  TURN_TTL_SECONDS: z.string().optional(),
  TURN_FETCH_TIMEOUT_MS: z.string().optional(),
});

export type Config = z.infer<typeof Schema> & {
  readonly limits: Limits;
  readonly allowedOrigins: readonly string[];
  readonly ice: IceSettings;
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
  const ice = parseIceSettings(raw);
  if ('problems' in ice) problems.push(...ice.problems);
  if (raw.TURN_KEY_ID !== undefined || raw.TURN_KEY_API_TOKEN !== undefined || raw.ICE_PROVIDER === 'cloudflare') {
    problems.push('CLOUDFLARE_UNSUPPORTED_ON_NODE');
  }

  /*
    Em produção a lista é obrigatória. Ela era lida e nunca aplicada; agora
    que é, "vazio = qualquer uma" em produção seria uma regra que não barra
    nada escrita como se barrasse.
  */
  if (raw.NODE_ENV === 'production' && raw.ALLOWED_ORIGINS.trim() === '') {
    problems.push(
      'ALLOWED_ORIGINS vazio em produção: qualquer página poderia abrir sinalização e gastar TURN. Liste a origem do front (ex.: https://tela.gg).',
    );
  }
  if (raw.NODE_ENV === 'production' && (raw.TURN_USERNAME !== undefined || raw.TURN_PASSWORD !== undefined)) {
    problems.push(
      'TURN com credencial estática em produção: qualquer espectador que abrir o DevTools ganha um relay permanente. Use TURN_SECRET.',
    );
  }
  if ('problems' in ice) return { problems };
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
      ice: ice.settings,
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
