import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { makeMemorySlugRepository } from './memory/slug-repository.memory.js';
import { makeMemoryPresenceStore } from './memory/presence-store.memory.js';
import { makeRedisSlugRepository } from './redis/slug-repository.redis.js';
import { makeRedisPresenceStore } from './redis/presence-store.redis.js';
import { unsafeSlug } from '../domain/slug.js';
import { unsafeRoomName } from '../domain/room.js';

/**
 * Redis de mentira, só o suficiente para os dois adapters. Semântica real:
 * HSET cria a chave se ela não existir; EXPIRE sem XX cria TTL em chave viva;
 * SREM que esvazia o set apaga a chave.
 */
function fakeRedis(clock: { t: number }) {
  type Row = { value: Map<string, string> | Set<string>; expiresAt: number | null };
  const db = new Map<string, Row>();

  const alive = (key: string): Row | null => {
    const row = db.get(key);
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt <= clock.t) {
      db.delete(key);
      return null;
    }
    return row;
  };
  const hashOf = (key: string): Map<string, string> => {
    const row = alive(key);
    if (row) return row.value as Map<string, string>;
    const created = new Map<string, string>();
    db.set(key, { value: created, expiresAt: null });
    return created;
  };
  const setOf = (key: string): Set<string> => {
    const row = alive(key);
    if (row) return row.value as Set<string>;
    const created = new Set<string>();
    db.set(key, { value: created, expiresAt: null });
    return created;
  };

  const commands = {
    async hsetnx(key: string, field: string, value: string): Promise<number> {
      const hash = hashOf(key);
      if (hash.has(field)) return 0;
      hash.set(field, value);
      return 1;
    },
    async hset(key: string, ...pairs: (string | number)[]): Promise<number> {
      const hash = hashOf(key);
      for (let i = 0; i < pairs.length; i += 2) {
        hash.set(String(pairs[i]), String(pairs[i + 1]));
      }
      return 1;
    },
    async hget(key: string, field: string): Promise<string | null> {
      return (alive(key)?.value as Map<string, string> | undefined)?.get(field) ?? null;
    },
    async hgetall(key: string): Promise<Record<string, string>> {
      const hash = alive(key)?.value as Map<string, string> | undefined;
      return hash ? Object.fromEntries(hash) : {};
    },
    async expire(key: string, seconds: number, mode?: string): Promise<number> {
      const row = alive(key);
      if (!row) return 0;
      if (mode === 'XX' && row.expiresAt === null) return 0;
      row.expiresAt = clock.t + seconds * 1000;
      return 1;
    },
    async exists(key: string): Promise<number> {
      return alive(key) ? 1 : 0;
    },
    async del(key: string): Promise<number> {
      return db.delete(key) ? 1 : 0;
    },
    async sadd(key: string, member: string): Promise<number> {
      const set = setOf(key);
      const had = set.has(member);
      set.add(member);
      return had ? 0 : 1;
    },
    async srem(key: string, member: string): Promise<number> {
      const set = alive(key)?.value as Set<string> | undefined;
      if (!set) return 0;
      const had = set.delete(member);
      if (set.size === 0) db.delete(key);
      return had ? 1 : 0;
    },
    async scard(key: string): Promise<number> {
      return ((alive(key)?.value as Set<string> | undefined)?.size ?? 0) as number;
    },
  };

  const multi = () => {
    const queue: (() => Promise<unknown>)[] = [];
    const chain = {
      hset: (...args: Parameters<typeof commands.hset>) => {
        queue.push(() => commands.hset(...args));
        return chain;
      },
      expire: (...args: Parameters<typeof commands.expire>) => {
        queue.push(() => commands.expire(...args));
        return chain;
      },
      sadd: (...args: Parameters<typeof commands.sadd>) => {
        queue.push(() => commands.sadd(...args));
        return chain;
      },
      exec: async () => {
        for (const step of queue) await step();
        return [];
      },
    };
    return chain;
  };

  return { ...commands, multi, db } as unknown as Redis & { db: typeof db };
}

const SLUG = unsafeSlug('joao');
const ROOM = unsafeRoomName('b_joao');

function pair() {
  const clock = { t: 1_000_000 };
  const redis = fakeRedis(clock);
  return {
    clock,
    redis,
    memoria: {
      slugs: makeMemorySlugRepository(() => clock.t),
      presence: makeMemoryPresenceStore(() => clock.t),
    },
    redisAdapters: {
      slugs: makeRedisSlugRepository(redis),
      presence: makeRedisPresenceStore(redis),
    },
  };
}

describe('BUGHUNT divergência memória × redis', () => {
  it('D1: touch em slug inexistente', async () => {
    const ctx = pair();
    await ctx.memoria.slugs.touch(SLUG, ctx.clock.t);
    await ctx.redisAdapters.slugs.touch(SLUG, ctx.clock.t);

    expect(await ctx.redisAdapters.slugs.exists(SLUG)).toBe(
      await ctx.memoria.slugs.exists(SLUG),
    );
  });

  it('D2: touch em slug expirado não ressuscita', async () => {
    const ctx = pair();
    await ctx.memoria.slugs.claim(SLUG, 'hash', ctx.clock.t);
    await ctx.redisAdapters.slugs.claim(SLUG, 'hash', ctx.clock.t);

    ctx.clock.t += 181 * 24 * 3600 * 1000; // além do SLUG_TTL

    await ctx.memoria.slugs.touch(SLUG, ctx.clock.t);
    await ctx.redisAdapters.slugs.touch(SLUG, ctx.clock.t);

    expect(await ctx.redisAdapters.slugs.exists(SLUG)).toBe(
      await ctx.memoria.slugs.exists(SLUG),
    );
    expect(await ctx.redisAdapters.slugs.ownerHashOf(SLUG)).toBe(
      await ctx.memoria.slugs.ownerHashOf(SLUG),
    );
  });

  it('D3: claim depois de um touch órfão', async () => {
    const ctx = pair();
    await ctx.memoria.slugs.touch(SLUG, ctx.clock.t);
    await ctx.redisAdapters.slugs.touch(SLUG, ctx.clock.t);

    expect(await ctx.redisAdapters.slugs.claim(SLUG, 'novo', ctx.clock.t)).toBe(
      await ctx.memoria.slugs.claim(SLUG, 'novo', ctx.clock.t),
    );
  });

  it('D4: addViewer renova o TTL do conjunto nos dois', async () => {
    const ctx = pair();
    await ctx.memoria.presence.addViewer(ROOM, 'v1', 60);
    await ctx.redisAdapters.presence.addViewer(ROOM, 'v1', 60);

    ctx.clock.t += 40_000;
    await ctx.memoria.presence.addViewer(ROOM, 'v2', 60);
    await ctx.redisAdapters.presence.addViewer(ROOM, 'v2', 60);

    ctx.clock.t += 40_000; // 80s do primeiro, 40s do segundo
    expect(await ctx.redisAdapters.presence.countViewers(ROOM)).toBe(
      await ctx.memoria.presence.countViewers(ROOM),
    );
  });

  it('D5: removeViewer do último espectador', async () => {
    const ctx = pair();
    await ctx.memoria.presence.addViewer(ROOM, 'v1', 60);
    await ctx.redisAdapters.presence.addViewer(ROOM, 'v1', 60);
    await ctx.memoria.presence.removeViewer(ROOM, 'v1');
    await ctx.redisAdapters.presence.removeViewer(ROOM, 'v1');

    // Depois de esvaziar, addViewer deve valer igual nos dois.
    await ctx.memoria.presence.addViewer(ROOM, 'v2', 60);
    await ctx.redisAdapters.presence.addViewer(ROOM, 'v2', 60);
    ctx.clock.t += 61_000;

    expect(await ctx.redisAdapters.presence.countViewers(ROOM)).toBe(
      await ctx.memoria.presence.countViewers(ROOM),
    );
  });

  it('D6: renewLive só renova o que está vivo (EXPIRE XX)', async () => {
    const ctx = pair();
    const state = { room: ROOM, startedAt: ctx.clock.t, publisherId: 'p1' };
    await ctx.memoria.presence.setLive(SLUG, state, 30);
    await ctx.redisAdapters.presence.setLive(SLUG, state, 30);

    ctx.clock.t += 31_000;
    expect(await ctx.redisAdapters.presence.renewLive(SLUG, 30)).toBe(
      await ctx.memoria.presence.renewLive(SLUG, 30),
    );
    expect(await ctx.redisAdapters.presence.getLive(SLUG)).toEqual(
      await ctx.memoria.presence.getLive(SLUG),
    );
  });

  it('D7: viewers herdam TTL do primeiro addViewer quando o publisher some', async () => {
    const ctx = pair();
    await ctx.memoria.presence.addViewer(ROOM, 'v1', 3600);
    await ctx.redisAdapters.presence.addViewer(ROOM, 'v1', 3600);
    await ctx.memoria.presence.clearViewers(ROOM);
    await ctx.redisAdapters.presence.clearViewers(ROOM);

    expect(await ctx.redisAdapters.presence.countViewers(ROOM)).toBe(
      await ctx.memoria.presence.countViewers(ROOM),
    );
  });
});
