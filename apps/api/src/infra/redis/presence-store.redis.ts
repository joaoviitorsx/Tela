import type { Redis } from 'ioredis';
import type { RoomName } from '../../domain/room.js';
import { unsafeRoomName } from '../../domain/room.js';
import type { Slug } from '../../domain/slug.js';
import type { LiveState, PresenceStore } from '../../ports/presence-store.js';

const liveKey = (slug: Slug) => `live:${slug}`;
const viewersKey = (room: RoomName) => `viewers:${room}`;

export function makeRedisPresenceStore(redis: Redis): PresenceStore {
  return {
    async setLive(slug, state, ttlSeconds) {
      await redis
        .multi()
        .hset(
          liveKey(slug),
          'room',
          state.room,
          'startedAt',
          state.startedAt,
          'publisherId',
          state.publisherId,
        )
        .expire(liveKey(slug), ttlSeconds)
        .exec();
    },

    /**
     * EXPIRE com a flag XX só renova se a chave AINDA existir. Sem isso o
     * heartbeat recriaria uma chave vazia e ressuscitaria uma transmissão
     * que já tinha morrido.
     */
    async renewLive(slug, ttlSeconds) {
      const result = await redis.expire(liveKey(slug), ttlSeconds, 'XX');
      return result === 1;
    },

    async getLive(slug) {
      const row = await redis.hgetall(liveKey(slug));
      if (!row['room'] || !row['startedAt'] || !row['publisherId']) return null;
      const state: LiveState = {
        room: unsafeRoomName(row['room']),
        startedAt: Number(row['startedAt']),
        publisherId: row['publisherId'],
      };
      return Number.isFinite(state.startedAt) ? state : null;
    },

    async clearLive(slug) {
      await redis.del(liveKey(slug));
    },

    async addViewer(room, identity, ttlSeconds) {
      await redis.multi().sadd(viewersKey(room), identity).expire(viewersKey(room), ttlSeconds).exec();
    },

    async removeViewer(room, identity) {
      await redis.srem(viewersKey(room), identity);
    },

    async countViewers(room) {
      return await redis.scard(viewersKey(room));
    },

    async clearViewers(room) {
      await redis.del(viewersKey(room));
    },
  };
}
