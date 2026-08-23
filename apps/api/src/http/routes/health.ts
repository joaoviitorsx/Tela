import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../composition.js';

export async function healthRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/health', async (_req, reply) => {
    const [store, gateway] = await Promise.all([deps.storeHealthy(), deps.gateway.isHealthy()]);
    const ok = store && gateway;
    return reply.status(ok ? 200 : 503).send({
      ok,
      transport: deps.transport,
      store,
      gateway,
      version: deps.version,
    });
  });
}
