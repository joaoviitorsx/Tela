import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Rate limit em memória, por processo.
 *
 * Deliberadamente não usa Redis: no modo P2P doméstico não existe Redis, e um
 * limite por processo já cumpre o objetivo — atrasar quem tenta reservar mil
 * slugs. Não é defesa contra DDoS distribuído; isso é trabalho do Caddy e do
 * firewall do provedor.
 */
type Bucket = { count: number; resetAt: number };

export type RateRule = { limit: number; windowSeconds: number };

declare module 'fastify' {
  interface FastifyInstance {
    rateLimit(rule: RateRule, keyOf?: (req: FastifyRequest) => string): (req: FastifyRequest) => void;
  }
}

export const rateLimitPlugin = fp(async (app: FastifyInstance) => {
  const buckets = new Map<string, Bucket>();

  // Varredura preguiçosa: sem timer periódico segurando o event loop.
  const sweep = (now: number) => {
    if (buckets.size < 10_000) return;
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  };

  app.decorate('rateLimit', (rule: RateRule, keyOf?: (req: FastifyRequest) => string) => {
    return (req: FastifyRequest) => {
      const now = Date.now();
      sweep(now);
      const key = `${req.routeOptions.url ?? req.url}:${keyOf ? keyOf(req) : req.ip}`;
      const bucket = buckets.get(key);

      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + rule.windowSeconds * 1000 });
        return;
      }
      bucket.count += 1;
      if (bucket.count > rule.limit) {
        const error = new Error('RATE_LIMITED') as Error & { appError: 'RATE_LIMITED' };
        error.appError = 'RATE_LIMITED';
        throw error;
      }
    };
  });
});

export const RATE_RULES = {
  claim: { limit: 5, windowSeconds: 3600 },
  join: { limit: 20, windowSeconds: 60 },
  start: { limit: 10, windowSeconds: 60 },
  ping: { limit: 12, windowSeconds: 60 },
} as const satisfies Record<string, RateRule>;
