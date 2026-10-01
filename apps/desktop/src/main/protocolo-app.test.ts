import { describe, expect, it } from 'vitest';
import { ORIGEM_APP, resolverArquivo } from './protocolo-app.js';

const RAIZ = '/opt/tela/web';
const PAGINA = `${RAIZ}/desktop.html`;
const ARQUIVOS = new Set([
  PAGINA,
  `${RAIZ}/assets/entry-abc123.js`,
  `${RAIZ}/assets/estilo.css`,
  `${RAIZ}/3d/tv.glb`,
  `${RAIZ}/fonte com espaço.woff2`,
]);
const existe = (p: string): boolean => ARQUIVOS.has(p);
const resolver = (url: string): string | null => resolverArquivo(RAIZ, url, existe);

describe('resolverArquivo', () => {
  it('serve o arquivo quando ele existe', () => {
    expect(resolver(`${ORIGEM_APP}/assets/entry-abc123.js`)).toBe(`${RAIZ}/assets/entry-abc123.js`);
    expect(resolver(`${ORIGEM_APP}/3d/tv.glb`)).toBe(`${RAIZ}/3d/tv.glb`);
  });

  it('decodifica percent-encoding antes de procurar', () => {
    expect(resolver(`${ORIGEM_APP}/fonte%20com%20espa%C3%A7o.woff2`)).toBe(`${RAIZ}/fonte com espaço.woff2`);
  });

  it('serve a página única na raiz e em toda rota do cliente', () => {
    expect(resolver(`${ORIGEM_APP}/`)).toBe(PAGINA);
    expect(resolver(`${ORIGEM_APP}`)).toBe(PAGINA);
    expect(resolver(`${ORIGEM_APP}/desktop.html`)).toBe(PAGINA);
    expect(resolver(`${ORIGEM_APP}/transmitir`)).toBe(PAGINA);
    expect(resolver(`${ORIGEM_APP}/recuperar`)).toBe(PAGINA);
    expect(resolver(`${ORIGEM_APP}/jv`)).toBe(PAGINA);
    expect(resolver(`${ORIGEM_APP}/jv?abertura=0#x`)).toBe(PAGINA);
    expect(resolver(`${ORIGEM_APP}/assets/`)).toBe(PAGINA);
    expect(resolver(`${ORIGEM_APP}/assets/nao-existe.js`)).toBe(PAGINA);
  });

  it('recusa outro host e outro esquema', () => {
    expect(resolver('app://outro/desktop.html')).toBeNull();
    expect(resolver('https://tela/desktop.html')).toBeNull();
    expect(resolver('isso não é url')).toBeNull();
  });

  describe('nunca sai da raiz', () => {
    const tentativas = [
      `${ORIGEM_APP}/../../../etc/passwd`,
      `${ORIGEM_APP}/assets/../../../../etc/passwd`,
      `${ORIGEM_APP}/..%2F..%2F..%2Fetc%2Fpasswd`,
      `${ORIGEM_APP}/%2e%2e/%2e%2e/etc/passwd`,
      `${ORIGEM_APP}/..\\..\\etc\\passwd`,
      `${ORIGEM_APP}/assets/entry-abc123.js%00.txt`,
      `${ORIGEM_APP}/%zz`,
    ];
    for (const url of tentativas) {
      it(url, () => {
        const visitados: string[] = [];
        const resultado = resolverArquivo(RAIZ, url, (p) => {
          visitados.push(p);
          return existe(p);
        });
        expect(resultado).toBe(PAGINA);
        for (const p of visitados) expect(p.startsWith(`${RAIZ}/`)).toBe(true);
      });
    }
  });

  it('um `..` que volta para dentro da raiz continua servindo o arquivo', () => {
    expect(resolver(`${ORIGEM_APP}/assets/../assets/estilo.css`)).toBe(`${RAIZ}/assets/estilo.css`);
  });

  it('a raiz pode vir relativa', () => {
    const resultado = resolverArquivo('web', `${ORIGEM_APP}/x`, () => false);
    expect(resultado).toBe(`${process.cwd()}/web/desktop.html`);
  });
});
