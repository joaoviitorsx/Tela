import { SLUG_TTL_SECONDS } from '../../domain/broadcast.js';
import type { SlugRepository } from '../../ports/slug-repository.js';
import { ExpiringMap } from './expiring-map.js';

type Row = { ownerHash: string; createdAt: number; lastSeenAt: number };

/**
 * Guarda o estado no processo. É o que permite `TELA_TRANSPORT=p2p` rodar sem
 * Redis, sem Docker, sem nada além de `node`: o caso de uso doméstico é um
 * usuário e um punhado de slugs.
 *
 * Custo consciente: o estado morre no restart. Em P2P doméstico isso significa
 * reivindicar o slug de novo — o localStorage do transmissor ainda tem o
 * ownerToken, então é um POST, não uma perda.
 */
export function makeMemorySlugRepository(now: () => number): SlugRepository {
  const rows = new ExpiringMap<Row>(now);

  return {
    async claim(slug, ownerHash, ts) {
      if (rows.has(slug)) return false;
      rows.set(slug, { ownerHash, createdAt: ts, lastSeenAt: ts }, SLUG_TTL_SECONDS);
      return true;
    },
    async ownerHashOf(slug) {
      return rows.get(slug)?.ownerHash ?? null;
    },
    async touch(slug, ts) {
      const row = rows.get(slug);
      if (!row) return;
      rows.set(slug, { ...row, lastSeenAt: ts }, SLUG_TTL_SECONDS);
    },
    async exists(slug) {
      return rows.has(slug);
    },
  };
}
