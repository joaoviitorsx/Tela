import type { AppError } from './errors.js';
import { type Result, err, ok } from './result.js';

/**
 * Branded type: uma `string` qualquer não passa onde se espera `Slug`.
 * A única porta de entrada é `parseSlug`, então tudo que circula como Slug
 * já foi validado contra a regex e as blocklists.
 */
declare const slugBrand: unique symbol;
export type Slug = string & { readonly [slugBrand]: true };

/**
 * Regex exatamente como nas §5 e §8.2 da documentação técnica: 3 a 25
 * caracteres.
 *
 * ATENÇÃO — contradição na documentação: a prosa usa `tela.gg/jv` como
 * exemplo, e `jv` tem 2 caracteres, então NÃO passa nesta regex. A regra
 * aparece escrita duas vezes ("3 a 25 caracteres" e a própria regex); o `jv`
 * aparece só como ilustração. Implementado o que está especificado como regra.
 * Para liberar slugs de 2 caracteres, troque `{1,23}` por `{0,23}` — é a
 * única mudança necessária. Registrado em docs/adr/0003.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,23}[a-z0-9]$/;

export type SlugPolicy = {
  readonly reserved: ReadonlySet<string>;
  readonly offensive: ReadonlySet<string>;
};

export function parseSlug(raw: string, policy: SlugPolicy): Result<Slug, AppError> {
  const candidate = raw.trim().toLowerCase();
  if (!SLUG_RE.test(candidate)) return err('SLUG_INVALID');
  if (policy.reserved.has(candidate)) return err('SLUG_RESERVED');
  if (policy.offensive.has(candidate)) return err('SLUG_RESERVED');
  return ok(candidate as Slug);
}

/** Só para quem já tem certeza (ex: valor lido do próprio Redis). */
export function unsafeSlug(raw: string): Slug {
  return raw as Slug;
}

const SUFFIXES = ['2', 'br', '-plays', '-live', 'gg'] as const;

/**
 * Sugestões para o 409. Determinístico de propósito: o mesmo slug tomado
 * sempre devolve a mesma lista, o que torna o teste possível e a UI estável.
 * `taken` permite pular sugestões que também já estão ocupadas.
 */
export function suggestAlternatives(
  raw: string,
  policy: SlugPolicy,
  taken: ReadonlySet<string> = new Set(),
  limit = 3,
): Slug[] {
  const base = raw.trim().toLowerCase();
  const out: Slug[] = [];
  for (const suffix of SUFFIXES) {
    if (out.length >= limit) break;
    const parsed = parseSlug(`${base}${suffix}`, policy);
    if (!parsed.ok) continue;
    if (taken.has(parsed.value)) continue;
    out.push(parsed.value);
  }
  return out;
}
