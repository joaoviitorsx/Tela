import { SLUG_RE } from '@tela/shared';

/** Os limites vêm da regra de `SLUG_RE` (3 a 25); aqui só viram frase. */
const MINIMO = 3;

/**
 * Qual das regras do nome o texto quebrou, em uma frase (B-04).
 *
 * Uma frase por regra: a pessoa não precisa descobrir qual das quatro valeu.
 * Devolve `null` quando o nome passa em `SLUG_RE` (reservados e ofensivos são
 * outra decisão, de `parseSlug`).
 */
export function motivoDoSlugInvalido(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  if (SLUG_RE.test(slug)) return null;
  if (/[^a-z0-9-]/.test(slug)) return 'Só letras, números e hífen.';
  if (slug.startsWith('-')) return 'Não pode começar com hífen.';
  if (slug.endsWith('-')) return 'Não pode terminar com hífen.';
  if (slug.length < MINIMO) {
    const falta = MINIMO - slug.length;
    return `${falta === 1 ? 'Falta 1 caractere' : `Faltam ${falta} caracteres`} (mínimo ${MINIMO}).`;
  }
  return 'No máximo 25 caracteres.';
}
