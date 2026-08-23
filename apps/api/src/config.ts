import { z } from 'zod';

/**
 * ÚNICO lugar do codebase que lê process.env (AGENTS.md / padrões §9).
 * Qualquer outro módulo que precise de configuração recebe por injeção.
 */

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const BaseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
  MAX_VIEWERS: z.coerce.number().int().min(1).max(64).default(12),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Topologia de mídia.
   *
   * `sfu` — LiveKit num servidor. O transmissor sobe uma vez, o servidor
   *         replica. É o modo para quem tem VPS.
   * `p2p` — mídia direto de browser para browser. O servidor só troca SDP/ICE.
   *         É o modo para quem quer hospedar na própria rede/máquina, sem VPS,
   *         sem LiveKit, sem Redis. Ver docs/adr/0002.
   */
  TELA_TRANSPORT: z.enum(['sfu', 'p2p']).default('sfu'),

  /** `memory` roda sem Redis — suficiente para um host doméstico de um usuário. */
  TELA_STORE: z.enum(['redis', 'memory']).optional(),
  REDIS_URL: z.string().optional(),

  /* ── SFU ── */
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  /** URL interna HTTP do LiveKit, usada pelo RoomServiceClient. */
  LIVEKIT_HTTP_URL: z.string().default('http://127.0.0.1:7880'),
  /** URL pública WebSocket entregue ao browser. */
  LIVEKIT_WS_URL: z.string().default('ws://127.0.0.1:7880'),

  /* ── P2P ── */
  /** HMAC dos tickets de sinalização. Obrigatório em p2p. */
  SIGNAL_SECRET: z.string().min(32).optional(),
  /** URL pública do WebSocket de sinalização entregue ao browser. */
  SIGNAL_WS_URL: z.string().default('ws://127.0.0.1:3333/api/signal'),
  /** Teto de espectadores em P2P: cada um é um encoder e uma cópia do upstream. */
  P2P_MAX_VIEWERS: z.coerce.number().int().min(1).max(8).default(3),
  STUN_URLS: z.string().default('stun:stun.l.google.com:19302'),
  TURN_URL: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_PASSWORD: z.string().optional(),

  TRUST_PROXY: bool.default(false),
});

export type Config = z.infer<typeof BaseSchema> & {
  readonly store: 'redis' | 'memory';
  readonly version: string;
  readonly iceServers: readonly { urls: string[]; username?: string; credential?: string }[];
};

function refine(raw: z.infer<typeof BaseSchema>): { config: Config } | { problems: string[] } {
  const problems: string[] = [];

  if (raw.TELA_TRANSPORT === 'sfu') {
    if (!raw.LIVEKIT_API_KEY) problems.push('LIVEKIT_API_KEY é obrigatório com TELA_TRANSPORT=sfu');
    if (!raw.LIVEKIT_API_SECRET)
      problems.push('LIVEKIT_API_SECRET é obrigatório com TELA_TRANSPORT=sfu');
  }

  if (raw.TELA_TRANSPORT === 'p2p' && !raw.SIGNAL_SECRET) {
    problems.push(
      'SIGNAL_SECRET (>=32 chars) é obrigatório com TELA_TRANSPORT=p2p — gere com: openssl rand -base64 36',
    );
  }

  const store = raw.TELA_STORE ?? (raw.REDIS_URL ? 'redis' : 'memory');
  if (store === 'redis' && !raw.REDIS_URL) {
    problems.push('TELA_STORE=redis exige REDIS_URL');
  }
  if (store === 'memory' && raw.NODE_ENV === 'production' && raw.TELA_TRANSPORT === 'sfu') {
    problems.push(
      'TELA_STORE=memory não serve para o modo SFU em produção: o estado morre no restart e não escala além de um processo',
    );
  }

  if (problems.length > 0) return { problems };

  const iceServers: Config['iceServers'] = [
    { urls: raw.STUN_URLS.split(',').map((u) => u.trim()).filter(Boolean) },
    ...(raw.TURN_URL && raw.TURN_USERNAME && raw.TURN_PASSWORD
      ? [
          {
            urls: [raw.TURN_URL],
            username: raw.TURN_USERNAME,
            credential: raw.TURN_PASSWORD,
          },
        ]
      : []),
  ];

  return { config: { ...raw, store, version: '1.0.0', iceServers } };
}

export function parseConfig(env: NodeJS.ProcessEnv): { config: Config } | { problems: string[] } {
  const parsed = BaseSchema.safeParse(env);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`),
    };
  }
  return refine(parsed.data);
}

/**
 * Falha rápido e alto. Config errada em produção é o tipo de bug que só
 * aparece quando o primeiro usuário tenta transmitir.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = parseConfig(env);
  if ('problems' in result) {
    for (const p of result.problems) console.error(`[config] ${p}`);
    process.exit(1);
  }
  return result.config;
}
