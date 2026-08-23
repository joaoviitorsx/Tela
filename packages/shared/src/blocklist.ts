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
]);

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
