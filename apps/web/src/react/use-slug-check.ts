import { SLUG_RE } from '@tela/shared';
import { useMemo } from 'react';
import { parseSlug } from '../core/domain/slug.js';
import { policy } from '../container.js';

export type SlugCheck =
  | { status: 'idle' }
  | { status: 'invalid'; message: string }
  | { status: 'ok' };

const MENSAGENS: Record<string, string> = {
  SLUG_INVALID:
    '3 a 25 caracteres: letras minúsculas, números e hífen. Não pode começar nem terminar com hífen.',
  SLUG_RESERVED: 'Esse nome não está disponível.',
};

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
    return {
      status: 'invalid',
      message: MENSAGENS[parsed.error] ?? MENSAGENS['SLUG_INVALID']!,
    };
  }, [raw]);
}

export { SLUG_RE };
