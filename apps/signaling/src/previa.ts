import { SLUG_RE, isBlockedSlug } from '@tela/shared';
import type { ConsultarEstado } from './estado-do-canal.js';
import type { EstadoPublico } from './worker.js';

/**
 * Prévia do link com o estado de verdade (o `<origem>/<slug>` da ADR 0026).
 *
 * O link nasce para ser colado num Discord. A prévia estática dizia "seu
 * amigo te chamou pra assistir" para sempre — inclusive três dias depois,
 * com o canal desligado. Agora o crawler que monta a prévia recebe o mesmo
 * `index.html` com o título trocado: "joao · AO VIVO agora · 3 assistindo" ou
 * "joao · fora do ar".
 *
 * # Só para crawler de prévia
 *
 * Quem abre o link num navegador não lê `og:title`: quem lê é o robô do
 * Discord, do WhatsApp, do Telegram. Perguntar ao Durable Object para cada
 * espectador humano seria uma ida e volta a mais antes do primeiro byte da
 * página — justamente na tela de quem acabou de clicar — para reescrever
 * metadados que ninguém vai ver. Robô fora da lista recebe a prévia
 * genérica, que é o comportamento de antes: degrada, não quebra.
 *
 * # Falha = página original
 *
 * Consulta que falha, estoura o prazo ou volta estranha devolve o HTML sem
 * reescrita. Nenhum crawler derruba nada, e nenhuma falha do objeto do canal
 * vira prévia quebrada.
 *
 * Nada de IP nem nome de espectador: o estado é `EstadoPublico`, dois campos.
 */

/** `Cache-Control` da página reescrita: estado muda, prévia não pode durar. */
export const CACHE_DA_PREVIA = 'public, max-age=30';

/**
 * Robôs que montam prévia de link. `facebookexternalhit` cobre também o
 * iMessage, que se apresenta com ele; `WhatsApp` aparece no UA do robô e não
 * no do navegador do app.
 */
const ROBOS_DE_PREVIA =
  /discordbot|whatsapp|telegrambot|twitterbot|facebookexternalhit|facebot|slackbot|linkedinbot|skypeuripreview|embedly|iframely|redditbot|mastodon|bluesky|cardyb|vkshare|pinterest/i;

export function ehRoboDePrevia(userAgent: string | null): boolean {
  return userAgent !== null && ROBOS_DE_PREVIA.test(userAgent);
}

/**
 * O slug do caminho, com a MESMA regra da rota do front (`parseRoute`): um
 * segmento, minúsculo, `SLUG_RE`, barras nas pontas ignoradas. Reservado
 * (`transmitir`, `recuperar`…) não é canal e não ganha prévia de canal.
 */
export function slugDaPrevia(pathname: string): string | null {
  const segmento = pathname.replace(/^\/+|\/+$/g, '');
  if (!SLUG_RE.test(segmento) || isBlockedSlug(segmento)) return null;
  return segmento;
}

export type TextosDaPrevia = { readonly titulo: string; readonly descricao: string };

export function textosDaPrevia(slug: string, estado: EstadoPublico): TextosDaPrevia {
  if (!estado.noAr) {
    return {
      titulo: `${slug} · fora do ar`,
      descricao: 'Quando a transmissão começar, é por este link. Abre no navegador, sem cadastro nem instalar nada.',
    };
  }
  const plateia = estado.espectadores > 0 ? ` · ${estado.espectadores} assistindo` : '';
  return {
    titulo: `${slug} · AO VIVO agora${plateia}`,
    descricao: 'Clica e assiste no navegador, sem cadastro nem instalar nada. Gameplay em 1080p com menos de 200ms de atraso.',
  };
}

/*
  O subconjunto do `HTMLRewriter` da Cloudflare que a prévia usa, declarado à
  mão pelo mesmo motivo dos outros tipos de plataforma deste pacote: puxar o
  `workers-types` inteiro por três membros. O global só existe no runtime; o
  ponto de entrada injeta, os testes trocam por um fake.
*/
export type ElementoReescrevivel = {
  setAttribute(nome: string, valor: string): unknown;
  setInnerContent(conteudo: string): unknown;
};

export type Reescritor = {
  on(seletor: string, tratador: { element(elemento: ElementoReescrevivel): void }): Reescritor;
  transform(resposta: Response): Response;
};

/**
 * Seletor → o que vai no lugar. `og:image` fica: a arte é estática, e trocar
 * o arquivo por estado faria Discord e WhatsApp guardarem a imagem errada no
 * cache deles pela URL (ver o comentário no `index.html`).
 */
export function reescreverPrevia(reescritor: Reescritor, textos: TextosDaPrevia, resposta: Response): Response {
  const conteudo = (valor: string) => ({
    element(elemento: ElementoReescrevivel) {
      elemento.setAttribute('content', valor);
    },
  });
  return reescritor
    .on('title', { element: (elemento) => void elemento.setInnerContent(textos.titulo) })
    .on('meta[property="og:title"]', conteudo(textos.titulo))
    .on('meta[property="og:description"]', conteudo(textos.descricao))
    .on('meta[name="twitter:title"]', conteudo(textos.titulo))
    .on('meta[name="twitter:description"]', conteudo(textos.descricao))
    .on('meta[name="description"]', conteudo(textos.descricao))
    .transform(resposta);
}

export type DepsDaPrevia = {
  readonly assets: (request: Request) => Promise<Response>;
  readonly consultar: ConsultarEstado;
  readonly reescritor: () => Reescritor;
};

/** Cabeçalhos condicionais: um 304 devolveria ao robô a prévia que ele já tinha. */
const CONDICIONAIS = ['if-none-match', 'if-modified-since'];

/**
 * Serve o front estático e, se for um robô de prévia pedindo a página de um
 * canal, troca os metadados pelo estado do canal.
 */
export async function servirComPrevia(request: Request, deps: DepsDaPrevia): Promise<Response> {
  const slug = slugDaPrevia(new URL(request.url).pathname);
  const metodo = request.method.toUpperCase();
  const aceita = request.headers.get('Accept');
  const querHtml = aceita === null || aceita === '' || /text\/html|\*\/\*/i.test(aceita);
  if (slug === null || (metodo !== 'GET' && metodo !== 'HEAD') || !querHtml ||
    !ehRoboDePrevia(request.headers.get('User-Agent'))) {
    return await deps.assets(request);
  }

  const headers = new Headers(request.headers);
  for (const nome of CONDICIONAIS) headers.delete(nome);
  const original = await deps.assets(new Request(request.url, { method: metodo, headers }));
  if (!original.ok || !(original.headers.get('content-type') ?? '').includes('text/html')) return original;

  let estado: EstadoPublico | null;
  try {
    estado = await deps.consultar(slug);
  } catch {
    estado = null;
  }
  if (estado === null) return original;

  const reescrita = reescreverPrevia(deps.reescritor(), textosDaPrevia(slug, estado), original);
  const resposta = new Response(reescrita.body, reescrita);
  resposta.headers.set('Cache-Control', CACHE_DA_PREVIA);
  // O mesmo caminho serve HTML diferente para robô e para gente.
  resposta.headers.append('Vary', 'User-Agent');
  // O ETag é do arquivo, não desta página: devolvê-lo convidaria um 304 errado.
  resposta.headers.delete('ETag');
  resposta.headers.delete('Last-Modified');
  return resposta;
}
