import { SLUG_RE } from '@tela/shared';
import { useMemo } from 'react';
import { motivoDoSlugInvalido } from '../core/domain/motivo-do-slug.js';
import { parseSlug } from '../core/domain/slug.js';
import { policy } from '../container.js';

export type SlugCheck =
  | { status: 'idle' }
  | { status: 'invalid'; message: string }
  | { status: 'ok' };

const MENSAGEM_RESERVADO = 'Esse nome não está disponível.';

/**
 * Validação de slug enquanto o usuário digita.
 *
 * Sem rede, e sem debounce, porque não há mais o que perguntar ao servidor: no
 * mesh não existe API HTTP, e o servidor de sinalização só responde no momento
 * do `host`. Verificar disponibilidade antes exigiria um endpoint novo cujo
 * único efeito seria transformar o serviço num oráculo de enumeração de slugs.
 *
 * Consequência aceita: o usuário só descobre que o nome está tomado ao apertar
 * TRANSMITIR. Em troca, a digitação não faz uma requisição por tecla e não há
 * como varrer quem existe.
 */
export function useSlugCheck(raw: string): SlugCheck {
  return useMemo(() => {
    const slug = raw.trim().toLowerCase();
    if (slug.length === 0) return { status: 'idle' };

    const parsed = parseSlug(slug, policy);
    if (parsed.ok) return { status: 'ok' };
    // Uma frase por regra quebrada (B-04); reservado é outra decisão.
    return {
      status: 'invalid',
      message: motivoDoSlugInvalido(slug) ?? MENSAGEM_RESERVADO,
    };
  }, [raw]);
}

export { SLUG_RE };
