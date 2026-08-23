import { LIVE_TTL_SECONDS } from '../domain/broadcast.js';
import type { AppError } from '../domain/errors.js';
import { type Result, err, ok } from '../domain/result.js';
import { roomNameFor } from '../domain/room.js';
import type { Slug } from '../domain/slug.js';
import type { PresenceStore } from '../ports/presence-store.js';

export type HeartbeatDeps = { presence: PresenceStore };
export type HeartbeatOutput = { viewers: number };

/**
 * Renova `live:{slug}`. Se o registro já expirou, NÃO ressuscita — devolve
 * NOT_LIVE e o cliente chama /start de novo. Ressuscitar aqui esconderia
 * uma transmissão que na prática já caiu.
 */
export function makeHeartbeatBroadcast(deps: HeartbeatDeps) {
  return async function heartbeat(slug: Slug): Promise<Result<HeartbeatOutput, AppError>> {
    const renewed = await deps.presence.renewLive(slug, LIVE_TTL_SECONDS);
    if (!renewed) return err('NOT_LIVE');
    const viewers = await deps.presence.countViewers(roomNameFor(slug));
    return ok({ viewers });
  };
}
