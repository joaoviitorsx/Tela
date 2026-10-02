import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EstadoPublico } from './worker.js';
import {
  CACHE_DA_PREVIA, type ElementoReescrevivel, type Reescritor, ehRoboDePrevia, servirComPrevia, slugDaPrevia,
  textosDaPrevia,
} from './previa.js';

/**
 * O `index.html` DE VERDADE: se alguém trocar um seletor lá, este teste
 * quebra aqui em vez de a prévia voltar genérica em silêncio.
 */
const INDEX = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');

const DISCORDBOT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const escapar = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * Fake do `HTMLRewriter` que entende os três seletores que a prévia usa —
 * `title`, `meta[property="…"]`, `meta[name="…"]`. O de verdade só existe no
 * runtime da Cloudflare; a conferência com ele é o `curl` contra o
 * `wrangler dev` descrito em docs/DISCORD.md.
 */
class ReescritorDeTeste implements Reescritor {
  readonly regras: [string, (e: ElementoReescrevivel) => void][] = [];

  on(seletor: string, tratador: { element(e: ElementoReescrevivel): void }): Reescritor {
    this.regras.push([seletor, (e) => tratador.element(e)]);
    return this;
  }

  transform(resposta: Response): Response {
    const regras = this.regras;
    const corpo = resposta.text().then((html) => {
      let saida = html;
      for (const [seletor, tratar] of regras) {
        if (seletor === 'title') {
          saida = saida.replace(/<title>[\s\S]*?<\/title>/, () => {
            let interno = '';
            tratar({ setAttribute: () => undefined, setInnerContent: (c) => { interno = escapar(c); } });
            return `<title>${interno}</title>`;
          });
          continue;
        }
        const [, attr, valor] = /^meta\[(property|name)="([^"]+)"\]$/.exec(seletor) ?? [];
        if (attr === undefined) throw new Error(`seletor que o fake não conhece: ${seletor}`);
        saida = saida.replace(/<meta\b[^>]*>/g, (tag) => {
          if (!tag.includes(`${attr}="${valor}"`)) return tag;
          let nova = tag;
          tratar({
            setAttribute: (nome, v) => { nova = nova.replace(new RegExp(`${nome}="[^"]*"`), `${nome}="${escapar(v)}"`); },
            setInnerContent: () => undefined,
          });
          return nova;
        });
      }
      return saida;
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new TextEncoder().encode(await corpo));
        c.close();
      },
    });
    return new Response(stream, resposta);
  }
}

function meta(html: string, attr: 'property' | 'name', valor: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
    if (tag.includes(`${attr}="${valor}"`)) return /content="([^"]*)"/.exec(tag)?.[1] ?? null;
  }
  return null;
}

function cenario(estado: EstadoPublico | null | 'lanca', opcoes: { status?: number; tipo?: string } = {}) {
  const consultas: string[] = [];
  const pedidosAoAsset: Request[] = [];
  const deps = {
    assets: async (request: Request) => {
      pedidosAoAsset.push(request);
      return new Response(INDEX, {
        status: opcoes.status ?? 200,
        headers: { 'content-type': opcoes.tipo ?? 'text/html; charset=utf-8', ETag: '"arquivo"' },
      });
    },
    consultar: async (slug: string) => {
      consultas.push(slug);
      if (estado === 'lanca') throw new Error('objeto caiu');
      return estado;
    },
    reescritor: () => new ReescritorDeTeste(),
  };
  const pedir = (caminho: string, ua: string | null = DISCORDBOT, extra: Record<string, string> = {}) =>
    servirComPrevia(new Request(`https://tela.example${caminho}`, {
      headers: { ...(ua === null ? {} : { 'User-Agent': ua }), Accept: 'text/html', ...extra },
    }), deps);
  return { pedir, consultas, pedidosAoAsset };
}

describe('slugDaPrevia', () => {
  it('a mesma regra da rota do front', () => {
    expect(slugDaPrevia('/joao')).toBe('joao');
    expect(slugDaPrevia('/joao/')).toBe('joao');
    expect(slugDaPrevia('/canal-do-ze')).toBe('canal-do-ze');
    expect(slugDaPrevia('/')).toBeNull();
    expect(slugDaPrevia('/JOAO')).toBeNull();
    // 3 a 25 caracteres (`SLUG_RE`): `jv` não é canal, nem aqui nem no front.
    expect(slugDaPrevia('/jv')).toBeNull();
    expect(slugDaPrevia('/joao/outra')).toBeNull();
    expect(slugDaPrevia('/og-convite.png')).toBeNull();
  });

  it('rota reservada do front não é canal', () => {
    expect(slugDaPrevia('/transmitir')).toBeNull();
    expect(slugDaPrevia('/recuperar')).toBeNull();
    expect(slugDaPrevia('/signal')).toBeNull();
  });
});

describe('ehRoboDePrevia', () => {
  it('robôs de prévia sim, navegador não', () => {
    expect(ehRoboDePrevia(DISCORDBOT)).toBe(true);
    expect(ehRoboDePrevia('WhatsApp/2.23.20.0')).toBe(true);
    expect(ehRoboDePrevia('TelegramBot (like TwitterBot)')).toBe(true);
    expect(ehRoboDePrevia('facebookexternalhit/1.1 Facebot Twitterbot/1.0')).toBe(true);
    expect(ehRoboDePrevia(CHROME)).toBe(false);
    expect(ehRoboDePrevia(null)).toBe(false);
  });
});

describe('textosDaPrevia', () => {
  it('no ar, com e sem plateia; fora do ar', () => {
    expect(textosDaPrevia('joao', { noAr: true, espectadores: 3 }).titulo).toBe('joao · AO VIVO agora · 3 assistindo');
    expect(textosDaPrevia('joao', { noAr: true, espectadores: 0 }).titulo).toBe('joao · AO VIVO agora');
    expect(textosDaPrevia('joao', { noAr: false, espectadores: 0 }).titulo).toBe('joao · fora do ar');
  });
});

describe('servirComPrevia', () => {
  it('canal no ar: títulos, descrições e <title> trocados; imagem fica', async () => {
    const c = cenario({ noAr: true, espectadores: 3 });
    const resposta = await c.pedir('/joao');
    const html = await resposta.text();

    expect(meta(html, 'property', 'og:title')).toBe('joao · AO VIVO agora · 3 assistindo');
    expect(meta(html, 'name', 'twitter:title')).toBe('joao · AO VIVO agora · 3 assistindo');
    expect(meta(html, 'property', 'og:description')).toContain('Clica e assiste');
    expect(meta(html, 'name', 'twitter:description')).toContain('Clica e assiste');
    expect(html).toContain('<title>joao · AO VIVO agora · 3 assistindo</title>');
    expect(meta(html, 'property', 'og:image')).toBe('/og-convite.png');
    expect(c.consultas).toEqual(['joao']);
  });

  it('canal fora do ar: diz que está fora', async () => {
    const html = await (await cenario({ noAr: false, espectadores: 0 }).pedir('/joao')).text();
    expect(meta(html, 'property', 'og:title')).toBe('joao · fora do ar');
    expect(html).toContain('<title>joao · fora do ar</title>');
  });

  it('cache curto, Vary e sem o ETag do arquivo', async () => {
    const resposta = await cenario({ noAr: true, espectadores: 1 }).pedir('/joao');
    expect(resposta.headers.get('Cache-Control')).toBe(CACHE_DA_PREVIA);
    expect(resposta.headers.get('Vary')).toContain('User-Agent');
    expect(resposta.headers.get('ETag')).toBeNull();
  });

  it('pedido condicional do robô não vira 304 com a prévia velha', async () => {
    const c = cenario({ noAr: true, espectadores: 1 });
    await c.pedir('/joao', DISCORDBOT, { 'If-None-Match': '"arquivo"' });
    expect(c.pedidosAoAsset[0]?.headers.get('If-None-Match')).toBeNull();
  });

  it('consulta falhou (null ou exceção): HTML original, sem reescrita', async () => {
    for (const estado of [null, 'lanca'] as const) {
      const resposta = await cenario(estado).pedir('/joao');
      const html = await resposta.text();
      expect(html).toBe(INDEX);
      expect(resposta.headers.get('Cache-Control')).toBeNull();
    }
  });

  it('navegador de gente: passa direto, sem perguntar ao canal', async () => {
    const c = cenario({ noAr: true, espectadores: 3 });
    const html = await (await c.pedir('/joao', CHROME)).text();
    expect(html).toBe(INDEX);
    expect(c.consultas).toEqual([]);
  });

  it('caminho que não é canal, método errado ou asset não-HTML: passa direto', async () => {
    const c = cenario({ noAr: true, espectadores: 3 });
    expect(await (await c.pedir('/')).text()).toBe(INDEX);
    expect(await (await c.pedir('/transmitir')).text()).toBe(INDEX);
    await servirComPrevia(new Request('https://tela.example/joao', {
      method: 'POST', headers: { 'User-Agent': DISCORDBOT },
    }), { assets: async () => new Response('x'), consultar: async () => { throw new Error('não'); }, reescritor: () => new ReescritorDeTeste() });
    expect(c.consultas).toEqual([]);

    const json = cenario({ noAr: true, espectadores: 3 }, { tipo: 'application/json' });
    expect(await (await json.pedir('/joao')).text()).toBe(INDEX);
    expect(json.consultas).toEqual([]);
  });
});
