import type { Slug } from '../domain/slug.js';

/**
 * Persistência do vínculo slug → dono.
 *
 * Nenhuma assinatura menciona Redis. O adapter em infra/redis decide chave,
 * TTL e atomicidade; o caso de uso só conhece a intenção.
 */
export type SlugRepository = {
  /**
   * Reserva o slug se ele estiver livre. DEVE ser atômico — dois usuários
   * pedindo o mesmo nome no mesmo instante não podem ambos receber `true`.
   */
  claim(slug: Slug, ownerHash: string, now: number): Promise<boolean>;

  /** `null` quando o slug nunca foi reivindicado (ou já expirou). */
  ownerHashOf(slug: Slug): Promise<string | null>;

  /** Renova o TTL e marca uso. Chamado em todo acesso autenticado. */
  touch(slug: Slug, now: number): Promise<void>;

  exists(slug: Slug): Promise<boolean>;
};
