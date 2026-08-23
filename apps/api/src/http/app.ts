import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { Config } from '../config.js';
import type { Deps } from '../composition.js';
import { corsPlugin } from './plugins/cors.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { broadcastRoutes } from './routes/broadcast.js';
import { claimRoutes } from './routes/claim.js';
import { healthRoutes } from './routes/health.js';
import { joinRoutes } from './routes/join.js';
import { liveRoutes } from './routes/live.js';
import { signalRoutes } from './routes/signal.js';
import { webhookRoutes } from './routes/webhook.js';

export async function buildApp(config: Config, deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      /**
       * O ownerToken é a credencial inteira do usuário — não existe senha para
       * trocar depois. Ele nunca pode chegar num arquivo de log, nem em corpo
       * de requisição, nem em mensagem de erro.
       */
      redact: {
        paths: [
          'req.body.ownerToken',
          'body.ownerToken',
          'req.headers.authorization',
          'connection.token',
          'connection.ticket',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    // Log de requisição em produção não agrega: o Caddy já registra acesso, e
    // menos log é menos IP em disco (§15). A chave só é incluída quando vale
    // `true` porque a própria presença dela dispara aviso de depreciação no
    // Fastify 5 — em 6 isso migra para `logController`.
    ...(config.NODE_ENV === 'production' ? { disableRequestLogging: true } : {}),
  });

  await app.register(errorHandlerPlugin);
  await app.register(rateLimitPlugin);
  await app.register(corsPlugin, {
    origins: [config.PUBLIC_BASE_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
  });

  if (deps.hub) await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  await app.register(
    async (api) => {
      await claimRoutes(api, deps);
      await broadcastRoutes(api, deps);
      await liveRoutes(api, deps);
      await joinRoutes(api, deps);
      await healthRoutes(api, deps);
      await webhookRoutes(api, deps);
      await signalRoutes(api, deps);
    },
    { prefix: '/api' },
  );

  return app;
}
