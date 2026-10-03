// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Container from './container.js';
import { ViewerSession } from './core/media/viewer-session.js';
import { FakeMediaTransport, FakeScheduler, fakeStream, fakeTrack } from './core/testing/fakes.js';
import { Viewer } from './routes/Viewer.js';

/*
  Guarda de custo do espectador (estudo 3, §2.3): NADA que fique na árvore da
  página de assistir pode ler o vídeo de trás. Medido: `backdrop-filter`,
  `filter` e `mix-blend-mode` sobre o <video> forçam o compositor a
  re-rasterizar o quadro, ~4x o custo de CPU/GPU de um overlay estático, e
  desligam a promoção do vídeo a overlay de hardware. Animação infinita
  repinta a camada para sempre. Ninguém vê isso num teste funcional, e o CRT é
  justamente o tipo de estética que atrai um `backdrop-blur` "só desta vez".

  # Como o teste decide, e por que assim

  Em vitest não há CSS compilado (o Tailwind roda no build), então não dá para
  perguntar o `getComputedStyle`. Duas fontes, nenhuma delas "olhar a imagem":

  1. as CLASSES de cada elemento renderizado, contra (a) os utilitários do
     Tailwind que geram esses efeitos e (b) as regras de `globals.css`, que é
     lido do disco e parseado — qualquer seletor lá que declare `filter`,
     `backdrop-filter`, `mix-blend-mode` ou animação `infinite` vira proibição,
     inclusive classes novas que ninguém lembrou de cadastrar aqui;
  2. o atributo `style` inline.

  O escopo é a árvore INTEIRA da rota menos o próprio <video>, e não só os
  "irmãos depois do vídeo": um filtro num ANTEPASSADO também filtra o vídeo, e
  um irmão antes dele pode ter z-index maior. Se algo tem de poder usar um
  efeito, a exceção entra por nome em `PERMITIDAS` — e a lista é uma decisão
  visível, com o motivo ao lado.
*/

/** Única animação infinita permitida sobre o vídeo: o LED de 8x8 px da barra. */
const PERMITIDAS_INFINITAS = new Set(['led-pisca']);

const UTILITARIOS_PROIBIDOS = [
  /^backdrop-/,
  /^blur(-|$)/,
  /^drop-shadow(-|$)/,
  /^brightness-/,
  /^contrast-/,
  /^grayscale(-|$)/,
  /^hue-rotate-/,
  /^invert(-|$)/,
  /^saturate-/,
  /^sepia(-|$)/,
  /^filter(-|$)/,
  /^mix-blend-/,
  /^bg-blend-/,
  /^animate-(spin|ping|pulse|bounce)$/,
  /^\[(-webkit-)?(backdrop-)?filter:/,
  /^\[mix-blend-mode:/,
  /^\[animation[^\]]*infinite/,
];

type RegraProibida = { readonly seletor: string; readonly motivo: string };

/** Remove os comentários, que contêm chaves e a palavra "filter" à vontade. */
function semComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Percorre as regras (aninhadas em `@layer`/`@media`, ignorando `@keyframes`)
 * e devolve os seletores cujo corpo declara um efeito proibido.
 */
function regrasProibidas(css: string): RegraProibida[] {
  const achadas: RegraProibida[] = [];
  const visitar = (texto: string, dentroDeKeyframes: boolean): void => {
    let i = 0;
    while (i < texto.length) {
      const abre = texto.indexOf('{', i);
      if (abre === -1) return;
      const cabeca = texto.slice(i, abre).trim();
      let fundo = 1;
      let j = abre + 1;
      while (j < texto.length && fundo > 0) {
        if (texto[j] === '{') fundo += 1;
        else if (texto[j] === '}') fundo -= 1;
        j += 1;
      }
      const corpo = texto.slice(abre + 1, j - 1);
      i = j;
      const ultimaDecl = cabeca.slice(cabeca.lastIndexOf(';') + 1).trim();
      if (ultimaDecl.startsWith('@')) {
        visitar(corpo, dentroDeKeyframes || /^@(-\w+-)?keyframes/.test(ultimaDecl));
        continue;
      }
      if (dentroDeKeyframes || ultimaDecl.length === 0) continue;
      const motivo = motivoDoCorpo(corpo);
      if (motivo === null) continue;
      for (const seletor of ultimaDecl.split(',')) achadas.push({ seletor: seletor.trim(), motivo });
    }
  };
  visitar(semComentarios(css), false);
  return achadas;
}

function motivoDoCorpo(corpo: string): string | null {
  // `[;{\s]` antes do nome: o `filter` dentro de um `url("data:...<filter id=")`
  // não tem `:` logo depois, então não casa.
  if (/(^|[;\s])(-webkit-)?(backdrop-)?filter\s*:/.test(corpo)) return 'filter/backdrop-filter';
  if (/(^|[;\s])mix-blend-mode\s*:/.test(corpo)) return 'mix-blend-mode';
  if (/(^|[;\s])animation(-iteration-count)?\s*:[^;]*\binfinite\b/.test(corpo)) return 'animação infinita';
  return null;
}

const CSS = // O vitest roda na raiz do pacote (`pnpm --filter @tela/web test`).
readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');
const REGRAS = regrasProibidas(CSS);

function classeProibida(token: string): string | null {
  // Tira as variantes (`hover:`, `md:`, `motion-reduce:`) e o `!` de important.
  const base = token.replace(/^(?:[\w-]+:)+/, '').replace(/^!/, '');
  for (const padrao of UTILITARIOS_PROIBIDOS) if (padrao.test(base)) return `utilitário ${token}`;
  return null;
}

/** Tudo de errado que dá para dizer de UM elemento, em frases. */
function problemasDe(el: Element): string[] {
  const out: string[] = [];
  const rotulo = `<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}">`;
  for (const token of (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) {
    const u = classeProibida(token);
    if (u !== null) out.push(`${rotulo}: ${u}`);
  }
  for (const regra of REGRAS) {
    let casa = false;
    try {
      casa = el.matches(regra.seletor);
    } catch {
      continue; // seletor que o happy-dom não entende (`:root[...]`, `::before`): fora do alcance.
    }
    if (!casa) continue;
    const classe = /\.([\w-]+)/.exec(regra.seletor)?.[1];
    if (regra.motivo === 'animação infinita' && classe !== undefined && PERMITIDAS_INFINITAS.has(classe)) continue;
    out.push(`${rotulo}: ${regra.seletor} em globals.css declara ${regra.motivo}`);
  }
  const estilo = el.getAttribute('style') ?? '';
  if (/(^|[;\s])(-webkit-)?(backdrop-)?filter\s*:|mix-blend-mode\s*:|animation[^;]*infinite/.test(estilo)) {
    out.push(`${rotulo}: style inline "${estilo}"`);
  }
  return out;
}

function problemasNaArvore(raiz: HTMLElement): string[] {
  const video = raiz.querySelector('video');
  expect(video, 'a rota precisa ter renderizado o <video>').not.toBeNull();
  return [...raiz.querySelectorAll('*')].filter((el) => el !== video).flatMap(problemasDe);
}

/* ─────────────────────────── montagem da rota ─────────────────────────── */

const ctx = vi.hoisted(() => {
  // O Vite injeta isto em build (`define`); o container lê ao ser importado.
  Object.assign(globalThis, { __TELA_VERSION__: null });
  return { fabrica: null as null | (() => unknown) };
});

// O container é a raiz de composição com adapters reais (WebSocket, WebRTC).
// Parcial de propósito: só o que decide O QUE a rota renderiza é trocado — a
// sessão (a REAL, sobre um transporte falso) e o "abrir no app". O resto fica
// como está, para a rota poder ganhar dependências sem quebrar este teste.
vi.mock('./container.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Container>()),
  createViewerSession: () => ctx.fabrica?.(),
  abrirNoApp: {
    ambiente: () => ({ pode: false }),
    tentar: () => Promise.resolve('sem-resposta'),
  },
  semAppMarca: { ler: () => true, gravar: () => undefined, limpar: () => undefined },
  espectador: { apelido: () => 'ana', chave: () => 'chave', definirApelido: () => undefined },
}));

let transporte: FakeMediaTransport;

beforeEach(() => {
  const scheduler = new FakeScheduler();
  const sessao = new ViewerSession({
    transport: () => {
      transporte = new FakeMediaTransport();
      return transporte;
    },
    scheduler,
    statsIntervalMs: 1_000,
  });
  ctx.fabrica = () => sessao;
});

afterEach(() => {
  cleanup();
  ctx.fabrica = null;
});

async function assistindo(comAudio: boolean) {
  const resultado = render(<Viewer canais={["joao"]} />);
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
  await act(async () => {
    // `srcObject` só aceita um MediaStream de verdade; o fake serve de molde
    // para as faixas, e o happy-dom entra com a instância.
    const molde = fakeStream(comAudio ? [fakeTrack('video'), fakeTrack('audio')] : [fakeTrack('video')]);
    transporte.deliver(
      Object.assign(new MediaStream(), {
        getTracks: () => molde.getTracks(),
        getAudioTracks: () => molde.getAudioTracks(),
        getVideoTracks: () => molde.getVideoTracks(),
      }),
    );
  });
  return resultado;
}

describe('Viewer: nada sobre o <video> lê o vídeo de trás nem anima em laço', () => {
  it('o detector enxerga o que deveria (sanidade do próprio teste)', () => {
    const nomes = REGRAS.map((r) => r.seletor);
    expect(nomes).toContain('.led-pisca');
    expect(nomes).toContain('.chiado-anda');
    const el = document.createElement('div');
    el.className = 'hover:backdrop-blur-sm';
    expect(problemasDe(el)).not.toEqual([]);
    el.className = 'mix-blend-screen';
    expect(problemasDe(el)).not.toEqual([]);
    el.className = 'animate-pulse';
    expect(problemasDe(el)).not.toEqual([]);
    el.className = 'chiado-anda';
    expect(problemasDe(el)).not.toEqual([]);
    el.className = 'led-pisca';
    expect(problemasDe(el)).toEqual([]);
    el.className = 'transition-opacity opacity-100 bg-black';
    el.setAttribute('style', 'transform: scale(1)');
    expect(problemasDe(el)).toEqual([]);
    el.setAttribute('style', 'filter: blur(2px)');
    expect(problemasDe(el)).not.toEqual([]);
  });

  it('assistindo, com o aviso de som e a barra', async () => {
    const { container } = await assistindo(true);
    expect(container.querySelector('video')).not.toBeNull();
    // Se a barra não montou, "nada de errado" seria vazio: confere que o teste VIU o overlay.
    expect(container.querySelector('.led-pisca')).not.toBeNull();
    expect(container.querySelectorAll('*').length).toBeGreaterThan(30);
    expect(problemasNaArvore(container)).toEqual([]);
  });

  it('com os controles escondidos (sobra o botão-fantasma)', async () => {
    const { container } = await assistindo(true);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Mostrar controles (H)"]')).not.toBeNull();
    expect(problemasNaArvore(container)).toEqual([]);
  });

  it('a única animação infinita sobre o vídeo é o LED de 8 px', async () => {
    const { container } = await assistindo(false);
    const animados = [...container.querySelectorAll('*')].filter((el) =>
      [...PERMITIDAS_INFINITAS].some((c) => el.classList.contains(c)),
    );
    expect(animados.length).toBeLessThanOrEqual(1);
    for (const el of animados) expect(el.className).toContain('h-2 w-2');
  });
});
