import type { Slug } from './slug.js';

/**
 * Nome de sala. O prefixo `b_` evita colisão com salas administrativas e
 * deixa o filtro nas métricas do SFU trivial (`livekit_room{name=~"b_.*"}`).
 */
declare const roomBrand: unique symbol;
export type RoomName = string & { readonly [roomBrand]: true };

export const ROOM_PREFIX = 'b_';

export function roomNameFor(slug: Slug): RoomName {
  return `${ROOM_PREFIX}${slug}` as RoomName;
}

export function slugFromRoomName(room: string): string | null {
  return room.startsWith(ROOM_PREFIX) ? room.slice(ROOM_PREFIX.length) : null;
}

export function unsafeRoomName(raw: string): RoomName {
  return raw as RoomName;
}
