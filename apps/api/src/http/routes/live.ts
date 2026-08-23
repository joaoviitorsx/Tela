import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../composition.js';

export async function liveRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get<{ Params: { slug: string } }>('/live/:slug', async (req, reply) => {
    const result = await deps.getLiveStatus(req.params.slug);
    // 2s de cache: o espectador offline faz polling e não há motivo para cada
    // aba aberta bater no store. Nunca 404 — ver get-live-status.ts.
    reply.header('Cache-Control', 'public, max-age=2');
    return reply.send(result.ok ? result.value : { live: false });
  });
}
