/**
 * A decisão do plugin de build do desktop: quem pede o container da web recebe
 * o do desktop.
 *
 * Rotas e hooks importam `../container.js` e nunca ficam sabendo que existe
 * outro. O `container.desktop.ts` faz `export * from '../container.js'` e
 * sobrescreve o que muda (link público, sinalização, transporte) — por isso é
 * o único importador que NÃO é redirecionado: redirecioná-lo seria um import
 * de si mesmo.
 *
 * Função pura, sem Vite: o plugin em `vite.desktop.config.ts` só a chama.
 */
export const CONTAINER_WEB = 'src/container.ts';
export const CONTAINER_DESKTOP = 'src/desktop/container.desktop.ts';

/** Caminhos como o Vite entrega: separador `/`, sem a query `?v=` do dev. */
function normalizar(caminho: string): string {
  const semQuery = caminho.split('?')[0] ?? caminho;
  return semQuery.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * @param raiz Raiz do pacote `apps/web` (absoluta).
 * @param resolvido O id absoluto que o Vite resolveu para o import.
 * @param importador Quem importou; `undefined` para entradas.
 * @returns O id do container desktop, ou `null` quando o import fica como está.
 */
export function destinoDoContainer(
  raiz: string,
  resolvido: string,
  importador: string | undefined,
): string | null {
  const base = normalizar(raiz);
  const web = `${base}/${CONTAINER_WEB}`;
  const desktop = `${base}/${CONTAINER_DESKTOP}`;
  if (normalizar(resolvido) !== web) return null;
  if (importador !== undefined && normalizar(importador) === desktop) return null;
  return desktop;
}
