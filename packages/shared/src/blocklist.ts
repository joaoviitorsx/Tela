/**
 * Slugs que nunca podem ser reivindicados.
 *
 * RESERVED: colidem com rotas do produto ou com arquivos servidos na raiz.
 * Se você criar uma rota nova em apps/web, adicione o segmento aqui — senão
 * o primeiro usuário que reivindicar aquele nome sequestra a rota.
 */
export const RESERVED: ReadonlySet<string> = new Set([
  'api',
  'rtc',
  'signal',
  'admin',
  'sobre',
  'about',
  'assets',
  'static',
  'health',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'index',
  'null',
  'undefined',
  'tela',
  'www',
  'turn',
  'stun',
  'live',
  'join',
  'claim',
  'broadcast',
  // Rotas do próprio front. Faltavam, e o efeito era silencioso: quem
  // reservasse `transmitir` recebia um link que a rota nunca resolve como
  // espectador — o amigo abria e via a tela inicial.
  'transmitir',
  'recuperar',
]);

/**
 * `true` quando o slug não pode ser reivindicado.
 *
 * Existe para que os DOIS servidores apliquem a mesma regra. Antes ela vivia
 * só no cliente, e pelo WebSocket cru o servidor aceitava `api`, `admin` e
 * termos ofensivos sem piscar — a validação era uma sugestão.
 */
export function isBlockedSlug(slug: string): boolean {
  const normalizado = slug.trim().toLowerCase();
  return RESERVED.has(normalizado) || OFFENSIVE.has(normalizado);
}

/**
 * Lista mínima e deliberadamente curta. Não é moderação de conteúdo — é só
 * evitar que o link do produto vire vitrine de termo ofensivo. Ampliar isso
 * é decisão de produto, não de engenharia.
 */
export const OFFENSIVE: ReadonlySet<string> = new Set([
  'puta',
  'caralho',
  'buceta',
  'viado',
  'nazista',
  'nazi',
  'hitler',
  'estupro',
  'pedofilo',
  'pedofilia',
  'cp',
]);
