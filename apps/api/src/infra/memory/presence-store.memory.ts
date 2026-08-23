import type { LiveState, PresenceStore } from '../../ports/presence-store.js';
import { ExpiringMap } from './expiring-map.js';

export function makeMemoryPresenceStore(now: () => number): PresenceStore {
  const live = new ExpiringMap<LiveState>(now);
  const viewers = new ExpiringMap<Set<string>>(now);

  return {
    async setLive(slug, state, ttlSeconds) {
      live.set(slug, state, ttlSeconds);
    },
    async renewLive(slug, ttlSeconds) {
      return live.touch(slug, ttlSeconds);
    },
    async getLive(slug) {
      return live.get(slug);
    },
    async clearLive(slug) {
      live.delete(slug);
    },
    async addViewer(room, identity, ttlSeconds) {
      const set = viewers.get(room) ?? new Set<string>();
      set.add(identity);
      viewers.set(room, set, ttlSeconds);
    },
    async removeViewer(room, identity) {
      viewers.get(room)?.delete(identity);
    },
    async countViewers(room) {
      return viewers.get(room)?.size ?? 0;
    },
    async clearViewers(room) {
      viewers.delete(room);
    },
  };
}
