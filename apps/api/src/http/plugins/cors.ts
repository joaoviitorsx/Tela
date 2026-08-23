import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Em produção o front é servido pelo mesmo domínio (Caddy), então CORS existe
 * só para o `pnpm dev`, onde o Vite roda em :5173 e a API em :3333.
 */
export const corsPlugin = fp(async (app: FastifyInstance, opts: { origins: string[] }) => {
  await app.register(cors, {
    origin: opts.origins,
    methods: ['GET', 'POST'],
    credentials: false,
    maxAge: 600,
  });
});
