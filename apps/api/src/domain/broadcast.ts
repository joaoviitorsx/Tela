/**
 * Constantes e regras puras da transmissão. Zero I/O, zero dependência.
 * Se um número aparece em dois lugares do código, ele mora aqui.
 */

/** `live:{slug}` expira em 30s; o transmissor renova a cada 10s. Três chances
 *  de perder o heartbeat antes da sala ser considerada morta. */
export const LIVE_TTL_SECONDS = 30;
export const HEARTBEAT_INTERVAL_SECONDS = 10;

/** Slug ativo nunca expira — o TTL é renovado a cada uso. */
export const SLUG_TTL_SECONDS = 180 * 24 * 3600;

/** Presença dos espectadores. Só existe para o servidor saber a contagem;
 *  o transmissor já sabe pelo próprio transporte. */
export const VIEWERS_TTL_SECONDS = 3600;

export const PUBLISHER_TOKEN_TTL_SECONDS = 6 * 3600;
export const VIEWER_TOKEN_TTL_SECONDS = 15 * 60;

/** Sala some 2min depois do último sair; participante que cai tem 20s de graça. */
export const EMPTY_TIMEOUT_SECONDS = 120;
export const DEPARTURE_TIMEOUT_SECONDS = 20;

export type BroadcastRole = 'publisher' | 'viewer';

/**
 * O transmissor ocupa uma vaga na sala. `maxViewers` é o número de
 * ESPECTADORES; a capacidade da sala é sempre um a mais.
 */
export function roomCapacity(maxViewers: number): number {
  return maxViewers + 1;
}

export function isAtViewerLimit(current: number, maxViewers: number): boolean {
  return current >= maxViewers;
}

/** `startedAt` em epoch ms → segundos, que é o formato do contrato público. */
export function toEpochSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}
