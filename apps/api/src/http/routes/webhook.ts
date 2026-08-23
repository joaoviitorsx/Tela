import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../composition.js';

/**
 * Só existe no modo SFU. A assinatura é verificada antes de qualquer efeito —
 * webhook não verificado é um endpoint que qualquer um usa para derrubar a
 * transmissão de qualquer pessoa.
 */
export async function webhookRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  if (!deps.webhooks) return;
  const verifier = deps.webhooks;

  app.post('/livekit/webhook', {
    // O LiveKit assina o corpo cru; o parser JSON do Fastify destruiria a
    // assinatura ao reserializar.
    config: { rawBody: true },
    handler: async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      const event = await verifier.verify(raw, req.headers.authorization);
      if (event === null) return reply.status(204).send();
      await deps.handleRoomEvent(event);
      return reply.status(204).send();
    },
  });
}
