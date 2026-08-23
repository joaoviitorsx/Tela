import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../composition.js';
import { httpStatusFor, messageFor } from '../error-mapping.js';
import { RATE_RULES } from '../plugins/rate-limit.js';

export async function joinRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const limit = app.rateLimit(RATE_RULES.join);

  app.post<{ Params: { slug: string } }>(
    '/join/:slug',
    { preHandler: (req, _reply, done) => (limit(req), done()) },
    async (req, reply) => {
      const result = await deps.joinBroadcast(req.params.slug);
      if (!result.ok) {
        return reply
          .status(httpStatusFor(result.error))
          .send({ error: result.error, message: messageFor(result.error) });
      }
      return reply.send({ connection: result.value.connection, identity: result.value.identity });
    },
  );
}
