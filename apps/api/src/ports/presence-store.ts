import type { RoomName } from '../domain/room.js';
import type { Slug } from '../domain/slug.js';

export type LiveState = {
  readonly room: RoomName;
  readonly startedAt: number;
  readonly publisherId: string;
};

/**
 * Estado efêmero: quem está ao vivo e quem está assistindo.
 * Tudo aqui tem TTL — nada sobrevive a um restart, e isso é intencional.
 */
export type PresenceStore = {
  setLive(slug: Slug, state: LiveState, ttlSeconds: number): Promise<void>;
  /** Só estende o TTL. Retorna false se a transmissão já tinha morrido. */
  renewLive(slug: Slug, ttlSeconds: number): Promise<boolean>;
  getLive(slug: Slug): Promise<LiveState | null>;
  clearLive(slug: Slug): Promise<void>;

  addViewer(room: RoomName, identity: string, ttlSeconds: number): Promise<void>;
  removeViewer(room: RoomName, identity: string): Promise<void>;
  countViewers(room: RoomName): Promise<number>;
  clearViewers(room: RoomName): Promise<void>;
};
