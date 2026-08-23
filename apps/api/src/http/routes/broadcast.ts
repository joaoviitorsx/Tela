import { OwnerRequestSchema } from '@tela/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../../composition.js';
import type { AppError } from '../../domain/errors.js';
import { type Result, err } from '../../domain/result.js';
import { type Slug, parseSlug } from '../../domain/slug.js';
import { httpStatusFor, messageFor } from '../error-mapping.js';
import { RATE_RULES } from '../plugins/rate-limit.js';

/**
 * O ownerToken viaja SEMPRE no corpo. Nunca em URL, query string ou header
 * customizado — os três acabam em log de proxy, em Referer e no histórico.
 */
export async function broadcastRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const limitStart = app.rateLimit(RATE_RULES.start);
  // Limite do ping é por transmissor, não por IP: uma casa com dois
  // transmissores atrás do mesmo NAT não pode derrubar um ao outro.
  const limitPing = app.rateLimit(RATE_RULES.ping, (req: FastifyRequest) => {
    const body = req.body as { slug?: unknown } | undefined;
    return typeof body?.slug === 'string' ? body.slug : req.ip;
  });

  async function auth(req: FastifyRequest): Promise<Result<Slug, AppError>> {
    const body = OwnerRequestSchema.safeParse(req.body);
    if (!body.success) return err('OWNER_INVALID');
    const slug = parseSlug(body.data.slug, deps.policy);
    if (!slug.ok) return err('OWNER_INVALID');
    return await deps.verifyOwner(slug.value, body.data.ownerToken);
  }

  const deny = (reply: FastifyReply, error: AppError) =>
    reply.status(httpStatusFor(error)).send({ error, message: messageFor(error) });

  app.post(
    '/broadcast/start',
    { preHandler: (req, _reply, done) => (limitStart(req), done()) },
    async (req, reply) => {
      const owner = await auth(req);
      if (!owner.ok) return deny(reply, owner.error);

      const result = await deps.startBroadcast(owner.value);
      if (!result.ok) return deny(reply, result.error);

      return reply.send({
        connection: result.value.connection,
        slug: result.value.slug,
        shareUrl: deps.shareUrlFor(result.value.slug),
      });
    },
  );

  app.post(
    '/broadcast/ping',
    { preHandler: (req, _reply, done) => (limitPing(req), done()) },
    async (req, reply) => {
      const owner = await auth(req);
      if (!owner.ok) return deny(reply, owner.error);

      const result = await deps.heartbeatBroadcast(owner.value);
      if (!result.ok) return deny(reply, result.error);

      return reply.send({ ok: true, viewers: result.value.viewers });
    },
  );

  app.post('/broadcast/stop', async (req, reply) => {
    const owner = await auth(req);
    if (!owner.ok) return deny(reply, owner.error);

    await deps.stopBroadcast(owner.value);
    return reply.send({ ok: true });
  });
}
