import type { LiveStatus } from '@tela/shared';
import { toEpochSeconds } from '../domain/broadcast.js';
import { type Result, ok } from '../domain/result.js';
import type { AppError } from '../domain/errors.js';
import type { SlugPolicy } from '../domain/slug.js';
import { parseSlug } from '../domain/slug.js';
import type { PresenceStore } from '../ports/presence-store.js';

export type GetLiveStatusDeps = { presence: PresenceStore; policy: SlugPolicy };

/**
 * Público e sem autenticação.
 *
 * Slug inválido, slug inexistente e slug offline devolvem exatamente a mesma
 * resposta `{live:false}` — não é 404. Quem varre nomes não consegue
 * distinguir "não existe" de "existe e está offline", que é a defesa contra
 * enumeração de slugs.
 */
export function makeGetLiveStatus(deps: GetLiveStatusDeps) {
  return async function getLiveStatus(rawSlug: string): Promise<Result<LiveStatus, AppError>> {
    const parsed = parseSlug(rawSlug, deps.policy);
    if (!parsed.ok) return ok({ live: false });

    const state = await deps.presence.getLive(parsed.value);
    if (state === null) return ok({ live: false });

    const viewers = await deps.presence.countViewers(state.room);
    return ok({ live: true, startedAt: toEpochSeconds(state.startedAt), viewers });
  };
}
