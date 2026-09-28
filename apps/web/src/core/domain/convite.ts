/**
 * O convite no link de quem assiste (TELA-018).
 *
 * Vai no FRAGMENTO (`#k=…`), não no caminho nem na query: o navegador não
 * manda o fragmento em requisição HTTP nenhuma, então ele não aparece em log
 * de servidor, de CDN ou de proxy. Não protege de quem tem o link — histórico,
 * área de transferência e a própria pessoa que recebeu —, e não é isso que
 * promete.
 */
const CONVITE_RE = /^[A-Za-z0-9_-]{22,128}$/;

export function linkComConvite(origem: string, slug: string, convite: string): string {
  return `${origem}/${slug}#k=${convite}`;
}

/** Lê o convite de `location.hash`. Qualquer coisa fora do formato é ausência. */
export function conviteDoFragmento(fragmento: string): string | null {
  const params = new URLSearchParams(fragmento.replace(/^#/, ''));
  const valor = params.get('k');
  return valor !== null && CONVITE_RE.test(valor) ? valor : null;
}
