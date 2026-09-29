/**
 * O link de quem assiste: só o nome do canal (ADR 0026).
 *
 * Teve um segredo no fragmento (`#k=…`, TELA-018). Saiu quando a aprovação
 * manual (ADR 0025) passou a decidir quem entra: o link voltou a ser algo que
 * se dita numa call. Links antigos com `#k=` continuam abrindo — o fragmento
 * é simplesmente ignorado.
 */
export function linkDoCanal(origem: string, slug: string): string {
  return `${origem}/${slug}`;
}
