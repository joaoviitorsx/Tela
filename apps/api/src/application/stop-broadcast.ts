import { type Result, ok } from '../domain/result.js';
import type { AppError } from '../domain/errors.js';
import { roomNameFor } from '../domain/room.js';
import type { Slug } from '../domain/slug.js';
import type { BroadcastGateway } from '../ports/broadcast-gateway.js';
import type { PresenceStore } from '../ports/presence-store.js';

export type StopBroadcastDeps = { presence: PresenceStore; gateway: BroadcastGateway };

/**
 * Sempre sucesso. Parar algo que já parou é o resultado desejado — e este
 * endpoint é chamado por `sendBeacon` no `beforeunload`, onde o cliente não
 * tem como tratar erro nenhum.
 */
export function makeStopBroadcast(deps: StopBroadcastDeps) {
  return async function stopBroadcast(slug: Slug): Promise<Result<null, AppError>> {
    const room = roomNameFor(slug);
    await deps.presence.clearLive(slug);
    await deps.presence.clearViewers(room);
    try {
      await deps.gateway.closeRoom(room);
    } catch {
      // Sala já sumiu ou o upstream caiu. O estado local já foi limpo, que é
      // o que o próximo /live vai ler.
    }
    return ok(null);
  };
}
