import { ClaimRequestSchema } from '@tela/shared';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../composition.js';
import { messageFor, httpStatusFor } from '../error-mapping.js';
import { RATE_RULES } from '../plugins/rate-limit.js';

export async function claimRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const limit = app.rateLimit(RATE_RULES.claim);

  app.post('/claim', { preHandler: (req, _reply, done) => (limit(req), done()) }, async (req, reply) => {
    const body = ClaimRequestSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'SLUG_INVALID', message: messageFor('SLUG_INVALID') });

    const result = await deps.claimSlug({ rawSlug: body.data.slug, ownerToken: body.data.ownerToken });
    if (!result.ok) {
      const { error, suggestions } = result.error;
      return reply
        .status(httpStatusFor(error))
        .send({ error, message: messageFor(error), ...(suggestions ? { suggestions } : {}) });
    }

    return reply.status(201).send({
      slug: result.value.slug,
      shareUrl: deps.shareUrlFor(result.value.slug),
    });
  });
}
