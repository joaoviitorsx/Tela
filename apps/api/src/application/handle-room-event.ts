import { VIEWERS_TTL_SECONDS } from '../domain/broadcast.js';
import { type Result, ok } from '../domain/result.js';
import type { AppError } from '../domain/errors.js';
import { type RoomName, slugFromRoomName, unsafeRoomName } from '../domain/room.js';
import { unsafeSlug } from '../domain/slug.js';
import type { PresenceStore } from '../ports/presence-store.js';

/**
 * Vocabulário próprio de evento de sala — deliberadamente NÃO é o tipo do
 * LiveKit. O adapter traduz. Assim o hub P2P emite os mesmos eventos e este
 * caso de uso serve aos dois transportes sem alteração.
 */
export type RoomEvent =
  | { kind: 'room_finished'; room: string }
  | { kind: 'participant_joined'; room: string; identity: string; isPublisher: boolean }
  | { kind: 'participant_left'; room: string; identity: string; isPublisher: boolean };

export type HandleRoomEventDeps = { presence: PresenceStore };

export function makeHandleRoomEvent(deps: HandleRoomEventDeps) {
  return async function handleRoomEvent(event: RoomEvent): Promise<Result<null, AppError>> {
    const room: RoomName = unsafeRoomName(event.room);
    const slugText = slugFromRoomName(event.room);
    if (slugText === null) return ok(null); // sala fora do nosso namespace

    switch (event.kind) {
      case 'room_finished':
        await deps.presence.clearViewers(room);
        await deps.presence.clearLive(unsafeSlug(slugText));
        return ok(null);

      case 'participant_joined':
        if (event.isPublisher) return ok(null);
        await deps.presence.addViewer(room, event.identity, VIEWERS_TTL_SECONDS);
        return ok(null);

      case 'participant_left':
        if (event.isPublisher) {
          // Transmissor saiu: a transmissão acabou, independente do TTL.
          await deps.presence.clearLive(unsafeSlug(slugText));
          await deps.presence.clearViewers(room);
          return ok(null);
        }
        await deps.presence.removeViewer(room, event.identity);
        return ok(null);
    }
  };
}
