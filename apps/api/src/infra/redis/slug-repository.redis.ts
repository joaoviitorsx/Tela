import type { Redis } from 'ioredis';
import { SLUG_TTL_SECONDS } from '../../domain/broadcast.js';
import type { Slug } from '../../domain/slug.js';
import type { SlugRepository } from '../../ports/slug-repository.js';

/**
 * Toda chave e todo TTL do Redis vivem neste arquivo e no presence-store.
 * Se você precisar saber o layout do Redis, é aqui — em nenhum outro lugar.
 */
const key = (slug: Slug) => `slug:${slug}`;

export function makeRedisSlugRepository(redis: Redis): SlugRepository {
  return {
    /**
     * HSETNX é atômico: dois usuários pedindo o mesmo slug no mesmo
     * milissegundo não podem ambos ganhar. Sem lock, sem transação.
     */
    async claim(slug, ownerHash, now) {
      const created = await redis.hsetnx(key(slug), 'ownerHash', ownerHash);
      if (created !== 1) return false;
      await redis
        .multi()
        .hset(key(slug), 'createdAt', now, 'lastSeenAt', now)
        .expire(key(slug), SLUG_TTL_SECONDS)
        .exec();
      return true;
    },

    async ownerHashOf(slug) {
      return await redis.hget(key(slug), 'ownerHash');
    },

    /** Slug em uso nunca expira: o TTL é empurrado para frente a cada acesso. */
    async touch(slug, now) {
      await redis
        .multi()
        .hset(key(slug), 'lastSeenAt', now)
        .expire(key(slug), SLUG_TTL_SECONDS)
        .exec();
    },

    async exists(slug) {
      return (await redis.exists(key(slug))) === 1;
    },
  };
}
