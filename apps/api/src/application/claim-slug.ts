import type { AppError } from '../domain/errors.js';
import { type Result, err, ok } from '../domain/result.js';
import { SLUG_TTL_SECONDS } from '../domain/broadcast.js';
import { type Slug, type SlugPolicy, parseSlug, suggestAlternatives } from '../domain/slug.js';
import type { Clock } from '../ports/clock.js';
import type { Hasher } from '../ports/hasher.js';
import type { SlugRepository } from '../ports/slug-repository.js';

export type ClaimSlugDeps = {
  slugs: SlugRepository;
  hasher: Hasher;
  clock: Clock;
  policy: SlugPolicy;
};

export type ClaimSlugInput = { rawSlug: string; ownerToken: string };
export type ClaimSlugOutput = { slug: Slug };
export type ClaimSlugFailure = { error: AppError; suggestions?: Slug[] };

export function makeClaimSlug(deps: ClaimSlugDeps) {
  return async function claimSlug(
    input: ClaimSlugInput,
  ): Promise<Result<ClaimSlugOutput, ClaimSlugFailure>> {
    const parsed = parseSlug(input.rawSlug, deps.policy);
    if (!parsed.ok) return err({ error: parsed.error });

    const slug = parsed.value;
    const ownerHash = deps.hasher.hash(input.ownerToken);
    const now = deps.clock.now();

    const claimed = await deps.slugs.claim(slug, ownerHash, now);
    if (claimed) return ok({ slug });

    // Já existe. Se for o MESMO dono, é reentrada legítima (trocou de aba,
    // reinstalou o browser com o token exportado) e não um conflito.
    const stored = await deps.slugs.ownerHashOf(slug);
    if (stored !== null && deps.hasher.equals(stored, ownerHash)) {
      await deps.slugs.touch(slug, now);
      return ok({ slug });
    }

    const taken = new Set<string>([slug]);
    const suggestions = suggestAlternatives(input.rawSlug, deps.policy, taken);
    const available: Slug[] = [];
    for (const candidate of suggestions) {
      if (!(await deps.slugs.exists(candidate))) available.push(candidate);
    }
    return err({ error: 'SLUG_TAKEN', suggestions: available });
  };
}

export const CLAIM_SLUG_TTL_SECONDS = SLUG_TTL_SECONDS;
