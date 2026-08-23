import type { Connection } from '@tela/shared';
import { VIEWERS_TTL_SECONDS, isAtViewerLimit } from '../domain/broadcast.js';
import type { AppError } from '../domain/errors.js';
import { type Result, err, ok } from '../domain/result.js';
import { type SlugPolicy, parseSlug } from '../domain/slug.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { PresenceStore } from '../ports/presence-store.js';
import type { TokenIssuer } from '../ports/token-issuer.js';

export type JoinBroadcastDeps = {
  presence: PresenceStore;
  tokens: TokenIssuer;
  ids: IdGenerator;
  policy: SlugPolicy;
  maxViewers: number;
};

export type JoinBroadcastOutput = { connection: Connection; identity: string };

export function makeJoinBroadcast(deps: JoinBroadcastDeps) {
  return async function joinBroadcast(
    rawSlug: string,
  ): Promise<Result<JoinBroadcastOutput, AppError>> {
    const parsed = parseSlug(rawSlug, deps.policy);
    if (!parsed.ok) return err('NOT_LIVE');

    const state = await deps.presence.getLive(parsed.value);
    if (state === null) return err('NOT_LIVE');

    const current = await deps.presence.countViewers(state.room);
    if (isAtViewerLimit(current, deps.maxViewers)) return err('VIEWER_LIMIT');

    // Identidade anônima e descartável. Nada aqui identifica pessoa.
    const identity = deps.ids.next('v');
    const connection = await deps.tokens.forViewer(state.room, identity);

    // Reserva otimista da vaga. A confirmação real vem pelo webhook do SFU
    // (ou pelo hub, em P2P); o TTL cobre quem pede token e nunca conecta.
    await deps.presence.addViewer(state.room, identity, VIEWERS_TTL_SECONDS);

    return ok({ connection, identity });
  };
}
