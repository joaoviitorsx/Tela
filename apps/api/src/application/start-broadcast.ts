import type { Connection } from '@tela/shared';
import { LIVE_TTL_SECONDS, roomCapacity } from '../domain/broadcast.js';
import type { AppError } from '../domain/errors.js';
import { type Result, err, ok } from '../domain/result.js';
import { roomNameFor } from '../domain/room.js';
import type { Slug } from '../domain/slug.js';
import type { BroadcastGateway } from '../ports/broadcast-gateway.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { PresenceStore } from '../ports/presence-store.js';
import type { TokenIssuer } from '../ports/token-issuer.js';

export type StartBroadcastDeps = {
  presence: PresenceStore;
  gateway: BroadcastGateway;
  tokens: TokenIssuer;
  ids: IdGenerator;
  clock: Clock;
  maxViewers: number;
};

export type StartBroadcastOutput = { connection: Connection; slug: Slug };

/**
 * Idempotente: chamar de novo com transmissão viva devolve a MESMA sala com
 * credencial nova. O transmissor que recarregou a aba não perde o link nem
 * derruba quem já está assistindo.
 */
export function makeStartBroadcast(deps: StartBroadcastDeps) {
  return async function startBroadcast(
    slug: Slug,
  ): Promise<Result<StartBroadcastOutput, AppError>> {
    const room = roomNameFor(slug);
    const now = deps.clock.now();

    const existing = await deps.presence.getLive(slug);
    const publisherId = existing?.publisherId ?? deps.ids.next('p');
    const startedAt = existing?.startedAt ?? now;

    try {
      await deps.gateway.ensureRoom(room, roomCapacity(deps.maxViewers));
    } catch {
      return err('UPSTREAM_UNAVAILABLE');
    }

    const connection = await deps.tokens.forPublisher(room, publisherId);
    await deps.presence.setLive(slug, { room, startedAt, publisherId }, LIVE_TTL_SECONDS);

    return ok({ connection, slug });
  };
}
