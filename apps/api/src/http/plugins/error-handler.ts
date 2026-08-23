import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ERROR_MAP } from '../error-mapping.js';
import type { AppError } from '../../domain/errors.js';

function appErrorOf(error: unknown): AppError | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { appError?: unknown }).appError;
  return typeof code === 'string' && code in ERROR_MAP ? (code as AppError) : null;
}

export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const appError = appErrorOf(error);
    if (appError) {
      const { status, message } = ERROR_MAP[appError];
      return reply.status(status).send({ error: appError, message });
    }

    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send({ error: 'SLUG_INVALID', message: 'Requisição inválida.' });
    }

    request.log.error({ err: error }, 'erro não tratado');
    return reply
      .status(500)
      .send({ error: 'UPSTREAM_UNAVAILABLE', message: 'Erro interno.' });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: 'SLUG_UNKNOWN', message: 'Rota não encontrada.' }),
  );
});
