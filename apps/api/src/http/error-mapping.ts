import type { AppError } from '../domain/errors.js';

/**
 * Record exaustivo por construção: adicionar um membro em `AppError` sem
 * decidir o status aqui quebra a compilação. É o motivo de AppError ser união
 * de literais e não uma classe de erro.
 */
export const ERROR_MAP: Record<AppError, { status: number; message: string }> = {
  SLUG_INVALID: {
    status: 400,
    message: 'Use 3 a 25 caracteres: letras minúsculas, números e hífen. Não pode começar nem terminar com hífen.',
  },
  SLUG_RESERVED: { status: 400, message: 'Esse nome não está disponível.' },
  SLUG_TAKEN: { status: 409, message: 'Esse link já é de outra pessoa.' },
  SLUG_UNKNOWN: { status: 404, message: 'Link não encontrado.' },
  // 401 tanto para token errado quanto para slug inexistente — distinguir
  // transformaria o endpoint num oráculo de enumeração de slugs.
  OWNER_INVALID: { status: 401, message: 'Credencial inválida para este link.' },
  NOT_LIVE: { status: 404, message: 'Ninguém está transmitindo neste link.' },
  RATE_LIMITED: { status: 429, message: 'Muitas tentativas. Espere um pouco.' },
  VIEWER_LIMIT: { status: 503, message: 'A transmissão está cheia.' },
  UPSTREAM_UNAVAILABLE: { status: 503, message: 'Servidor de mídia indisponível.' },
};

export function httpStatusFor(error: AppError): number {
  return ERROR_MAP[error].status;
}

export function messageFor(error: AppError): string {
  return ERROR_MAP[error].message;
}
