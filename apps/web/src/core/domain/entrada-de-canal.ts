import type { AppError } from './errors.js';
import { type Result, err } from './result.js';
import { type Slug, parseSlug } from './slug.js';

/**
 * De "o que a pessoa colou" para o canal (D8, ASSISTIR no app).
 *
 * Quem recebe o convite na call cola o que veio: o link inteiro, o link sem o
 * `https://`, o link do app, ou só o nome. Aceita as quatro formas e devolve o
 * mesmo `Slug` de sempre — o resto do caminho (rota `/<slug>`) não muda.
 *
 * Só o NOME do canal é lido. O host de um `https://` não é conferido: o link
 * pode vir do domínio público ou de um domínio de teste, e o app só navega
 * para a rota interna `/<slug>`, nunca para o endereço colado. Consulta e
 * fragmento (um `#k=` de link antigo, ADR 0026) são ignorados.
 */

/** Rotas do site que o roteador resolve antes de olhar o slug: não são canais. */
const POLITICA: { readonly reserved: ReadonlySet<string>; readonly offensive: ReadonlySet<string> } = {
  reserved: new Set(['transmitir', 'recuperar']),
  offensive: new Set(),
};

const TAMANHO_MAXIMO = 512;

/** `tela://assistir/<slug>` — igual ao validador do processo principal. */
const LINK_DO_APP = /^tela:\/\/assistir\/([^/?#\s]+)\/?(?:[?#].*)?$/i;

/** Esquema com `//` (`https://`, `ftp://`…); `localhost:5173/x` não é: falta a dupla barra. */
const COM_ESQUEMA = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `mailto:x`, `javascript:x`: esquema sem barras, e nome de canal não tem `:`. */
const COM_DOIS_PONTOS = /:/;

/** O único segmento de um caminho `/<slug>/`, ou `null` se houver mais de um ou nenhum. */
function segmentoUnico(caminho: string): string | null {
  const partes = caminho.split('/').filter((p) => p !== '');
  return partes.length === 1 ? (partes[0] ?? null) : null;
}

function slugDeUrlWeb(texto: string): string | null {
  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return segmentoUnico(url.pathname);
}

export function canalDaEntrada(entrada: string): Result<Slug, AppError> {
  const texto = entrada.trim();
  if (texto === '' || texto.length > TAMANHO_MAXIMO || /\s/.test(texto)) return err('SLUG_INVALID');

  let bruto: string | null;
  const doApp = LINK_DO_APP.exec(texto);
  if (doApp !== null) {
    bruto = doApp[1] ?? null;
  } else if (COM_ESQUEMA.test(texto)) {
    bruto = slugDeUrlWeb(texto);
  } else if (texto.includes('/')) {
    // `tela.gg/nome`: sem esquema, mas com cara de endereço (o host tem ponto).
    const host = texto.split('/')[0] ?? '';
    bruto = host.includes('.') || host.startsWith('localhost') ? slugDeUrlWeb(`https://${texto}`) : null;
  } else if (COM_DOIS_PONTOS.test(texto)) {
    return err('SLUG_INVALID');
  } else {
    bruto = texto;
  }

  if (bruto === null) return err('SLUG_INVALID');
  return parseSlug(bruto, POLITICA);
}
