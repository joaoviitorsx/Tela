/**
 * A decisão do plugin de build do desktop: quem pede um container da web
 * (`container.ts` ou `container-transmissao.ts`) recebe o do desktop.
 *
 * Rotas e hooks importam `../container.js` e `../container-transmissao.js` e
 * nunca ficam sabendo que existe outro. O `container.desktop.ts` faz
 * `export *` dos dois e sobrescreve o que muda (link público, sinalização,
 * transporte) — por isso NÃO é redirecionado: seria um import de si mesmo.
 * O `container-transmissao.ts` também fica de fora: ele importa o `container.ts`
 * (storage, scheduler), e redirecionar isso fecharia um ciclo com o desktop.
 *
 * Função pura, sem Vite: o plugin em `vite.desktop.config.ts` só a chama.
 */
export const CONTAINER_WEB = 'src/container.ts';
export const CONTAINER_TRANSMISSAO = 'src/container-transmissao.ts';
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
  const desktop = `${base}/${CONTAINER_DESKTOP}`;
  const alvo = normalizar(resolvido);
  if (alvo !== `${base}/${CONTAINER_WEB}` && alvo !== `${base}/${CONTAINER_TRANSMISSAO}`) return null;
  if (importador !== undefined) {
    const quem = normalizar(importador);
    if (quem === desktop || quem === `${base}/${CONTAINER_TRANSMISSAO}`) return null;
  }
  return desktop;
}
