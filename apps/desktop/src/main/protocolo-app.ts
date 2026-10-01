import { posix, resolve, sep } from 'node:path';

/**
 * Resolução de `app://tela/<caminho>` para um arquivo do renderer compilado.
 *
 * Pura: quem chama injeta "existe arquivo aqui?" para que a lógica — host,
 * decodificação, normalização, contenção na raiz e a volta para a página
 * única — seja testável sem disco e sem Electron. O `protocol.handle` em
 * `main.ts` só embrulha isto em `net.fetch`.
 */
export const HOST_APP = 'tela';
export const ESQUEMA_APP = 'app';
/** A origem da interface, como o Worker a aceita em `ALLOWED_ORIGINS` (§3.5). */
export const ORIGEM_APP = `${ESQUEMA_APP}://${HOST_APP}`;
/** A página única do renderer desktop (`apps/web/desktop.html`). */
export const PAGINA_UNICA = 'desktop.html';

/**
 * O arquivo a servir, absoluto e DENTRO de `raiz`, ou `null` quando o pedido
 * não é desta origem.
 *
 * Qualquer caminho que não seja um arquivo existente serve `desktop.html`:
 * `/transmitir`, `/recuperar` e `/<slug>` são rotas do cliente, e o roteador
 * da página decide o que mostrar. Um `..` nunca escapa: o caminho é
 * normalizado como absoluto (o `..` no topo some) e, por garantia, o
 * resultado é conferido contra a raiz antes de qualquer leitura.
 */
export function resolverArquivo(
  raiz: string,
  url: string,
  existeArquivo: (caminho: string) => boolean,
): string | null {
  const raizAbsoluta = resolve(raiz);
  const pagina = resolve(raizAbsoluta, PAGINA_UNICA);

  let analisada: URL;
  try {
    analisada = new URL(url);
  } catch {
    return null;
  }
  if (analisada.protocol !== `${ESQUEMA_APP}:` || analisada.host !== HOST_APP) return null;

  let caminho: string;
  try {
    caminho = decodeURIComponent(analisada.pathname);
  } catch {
    // Percent-encoding inválido não é rota nenhuma: a página decide.
    return pagina;
  }
  // Byte nulo corta o caminho em C; o Node recusa com exceção, e isto é um
  // pedido malformado, não uma rota.
  if (caminho.includes('\0')) return pagina;

  const relativo = posix.normalize(`/${caminho.replaceAll('\\', '/')}`).slice(1);
  if (relativo === '' || relativo.endsWith('/')) return pagina;

  const candidato = resolve(raizAbsoluta, relativo);
  const dentro = candidato === raizAbsoluta || candidato.startsWith(raizAbsoluta + sep);
  if (!dentro) return pagina;

  return existeArquivo(candidato) ? candidato : pagina;
}
