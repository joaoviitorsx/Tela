import type { AppError } from '../domain/errors.js';
import { type Result, err, ok } from '../domain/result.js';
import type { Slug } from '../domain/slug.js';
import type { Clock } from '../ports/clock.js';
import type { Hasher } from '../ports/hasher.js';
import type { SlugRepository } from '../ports/slug-repository.js';

export type VerifyOwnerDeps = { slugs: SlugRepository; hasher: Hasher; clock: Clock };

/**
 * Compartilhado por start/ping/stop. Não é caso de uso exposto — é a regra de
 * autenticação do produto inteiro, num lugar só.
 *
 * Devolve SEMPRE `OWNER_INVALID`, tanto para slug inexistente quanto para token
 * errado: distinguir os dois transformaria o endpoint num oráculo de
 * enumeração de slugs.
 */
export function makeVerifyOwner(deps: VerifyOwnerDeps) {
  return async function verifyOwner(
    slug: Slug,
    ownerToken: string,
  ): Promise<Result<Slug, AppError>> {
    const stored = await deps.slugs.ownerHashOf(slug);
    if (stored === null) return err('OWNER_INVALID');
    if (!deps.hasher.equals(stored, deps.hasher.hash(ownerToken))) {
      return err('OWNER_INVALID');
    }
    await deps.slugs.touch(slug, deps.clock.now());
    return ok(slug);
  };
}
