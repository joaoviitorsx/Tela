import { SLUG_RE } from '@tela/shared';

/**
 * O caminho da multivisão (ADR 0032): `/<a>+<b>`.
 *
 * O `SLUG_RE` não aceita `+`, então nenhum canal tem esse caminho — o link
 * composto não colide com nome nenhum. A ordem é a do layout: o primeiro é a
 * principal.
 */
export const MAX_CANAIS = 2;
const SEPARADOR = '+';
/** Rotas do site: não são canais (o mesmo que o link profundo e a prévia recusam). */
const ROTAS: ReadonlySet<string> = new Set(['transmitir', 'recuperar']);

/**
 * Os canais de um segmento de caminho, ou `null` se algum pedaço não é canal.
 *
 * Repetido conta uma vez (`a+a` é `a`). Mais que `MAX_CANAIS` fica com os
 * primeiros: o link de quem tem uma versão mais nova abre no que esta aguenta,
 * em vez de virar "não encontrado".
 */
export function canaisDoSegmento(segmento: string): readonly string[] | null {
  const partes = segmento.split(SEPARADOR);
  if (partes.some((p) => !SLUG_RE.test(p) || (partes.length > 1 && ROTAS.has(p)))) return null;
  return [...new Set(partes)].slice(0, MAX_CANAIS);
}

/** O caminho de uma lista de canais, na ordem dada. */
export function caminhoDosCanais(canais: readonly string[]): string {
  return `/${canais.join(SEPARADOR)}`;
}
