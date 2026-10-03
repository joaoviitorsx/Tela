/**
 * Multivisão (ADR 0032) com navegadores reais: dois anfitriões publicando
 * canvas de cores diferentes e um espectador em `/<a>+<b>`.
 *
 * Prova o que os testes de unidade não alcançam:
 * - os dois canais chegam ao mesmo tempo, cada um no seu `<video>`;
 * - TROCAR não reconecta: mesmos elementos, mesmo `srcObject`, nenhum
 *   WebSocket novo — e a cor do centro da principal passa a ser a do outro;
 * - o som segue a principal (a secundária fica muda);
 * - a barra de endereço acompanha (`/b+a`);
 * - fechar, `+ TELA` e lado a lado.
 *
 * Rodar com `pnpm dev` no ar: `node e2e/multivisao.e2e.mjs`.
 */
import { chromium } from 'playwright';

const CHROME = process.env.CHROME ?? chromium.executablePath();
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const A = 'ana-mv';
const B = 'bia-mv';

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-running-insecure-content',
    '--disable-web-security',
  ],
});

async function novaPagina(rotulo, init) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${rotulo}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${rotulo}] console.error: ${m.text()}`);
  });
  return page;
}

/** Um anfitrião publicando um canvas de uma cor só (`rgb`). */
async function anfitriao(slug, rgb) {
  const page = await novaPagina(`host ${slug}`);
  await page.goto(`${WEB}/?abertura=0`, { waitUntil: 'networkidle' });
  await page.evaluate(
    async ([slug, rgb]) => {
      const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
      const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
      const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
      const shared = await import('/node_modules/@tela/shared/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let quadro = 0;
      setInterval(() => {
        quadro += 1;
        ctx.fillStyle = `rgb(${rgb.join(',')})`;
        ctx.fillRect(0, 0, 640, 360);
        // Um canto que muda: o encoder precisa de movimento para seguir mandando.
        ctx.fillStyle = quadro % 2 ? '#fff' : '#000';
        ctx.fillRect(0, 0, 16, 16);
      }, 33);
      const track = canvas.captureStream(30).getVideoTracks()[0];
      track.contentHint = 'motion';
      const transport = makeMeshTransport({
        channel: makeWsSignaling(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`),
        scheduler: makeBrowserScheduler(),
      });
      window.__transport = transport;
      await transport.host(slug, slug.padEnd(43, 'x'));
      await transport.publishVideo(track, shared.PRESET_720P60);
    },
    [slug, rgb],
  );
  return page;
}

const hostA = await anfitriao(A, [220, 30, 30]);
const hostB = await anfitriao(B, [30, 60, 220]);
console.log('\n1. Dois anfitriões no ar');

// Conta WebSockets abertos: trocar a principal não pode abrir nenhum.
const viewer = await novaPagina('viewer', () => {
  window.__ws = 0;
  const Original = window.WebSocket;
  window.WebSocket = class extends Original {
    constructor(...args) {
      super(...args);
      window.__ws += 1;
    }
  };
});
await viewer.goto(`${WEB}/${A}+${B}`, { waitUntil: 'domcontentloaded' });

/** Cor média do centro do `<video>` de um canal: [r, g, b]. */
const corDoCentro = (canal) =>
  viewer.evaluate((canal) => {
    const v = document.querySelector(`[data-canal="${canal}"] video`);
    if (!v || v.videoWidth === 0) return null;
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 18;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, 32, 18);
    const d = ctx.getImageData(12, 6, 8, 6).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }, canal);

const ehVermelho = (c) => c !== null && c[0] > 150 && c[2] < 100;
const ehAzul = (c) => c !== null && c[2] > 150 && c[0] < 100;

const chegou = async (canal) =>
  viewer.evaluate((canal) => {
    const v = document.querySelector(`[data-canal="${canal}"] video`);
    return Boolean(v && v.srcObject && v.videoWidth > 0 && !v.paused);
  }, canal);

console.log('\n2. O espectador em /a+b recebe os dois');
let ambos = false;
for (let i = 0; i < 30 && !ambos; i += 1) {
  await viewer.waitForTimeout(1000);
  ambos = (await chegou(A)) && (await chegou(B));
}
ok(ambos, 'os dois canais chegaram, cada um no seu <video>');

const papeis = await viewer.evaluate(() => ({
  principal: document.querySelector('[data-papel="principal"]')?.getAttribute('data-canal'),
  secundaria: document.querySelector('[data-papel="secundaria"]')?.getAttribute('data-canal'),
  mudaSecundaria: document.querySelector('[data-papel="secundaria"] video')?.muted,
}));
ok(papeis.principal === A && papeis.secundaria === B, `principal ${papeis.principal}, secundária ${papeis.secundaria}`);
ok(papeis.mudaSecundaria === true, 'a secundária está muda');
ok(ehVermelho(await corDoCentro(A)) && ehAzul(await corDoCentro(B)), 'cada <video> mostra o canal certo (vermelho e azul)');

const caixa = (papel) =>
  viewer.evaluate((papel) => {
    const r = document.querySelector(`[data-papel="${papel}"]`)?.getBoundingClientRect();
    return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
  }, papel);
const pipAntes = await caixa('secundaria');
ok(pipAntes !== null && pipAntes.w < 640 && pipAntes.w >= 150, `a secundária é um quadro no canto (${pipAntes?.w}×${pipAntes?.h})`);

console.log('\n3. Clicar no quadro troca, SEM reconectar');
await viewer.evaluate(() => {
  window.__vA = document.querySelector('[data-canal="ana-mv"] video');
  window.__vB = document.querySelector('[data-canal="bia-mv"] video');
  window.__sA = window.__vA.srcObject;
  window.__sB = window.__vB.srcObject;
  window.__wsAntes = window.__ws;
});
await viewer.click('[data-papel="secundaria"] button[aria-label^="Trocar"]');
await viewer.waitForTimeout(800);
const depois = await viewer.evaluate(() => ({
  principal: document.querySelector('[data-papel="principal"]')?.getAttribute('data-canal'),
  mesmosElementos:
    document.querySelector('[data-canal="ana-mv"] video') === window.__vA &&
    document.querySelector('[data-canal="bia-mv"] video') === window.__vB,
  mesmosStreams: window.__vA.srcObject === window.__sA && window.__vB.srcObject === window.__sB,
  wsNovos: window.__ws - window.__wsAntes,
  caminho: location.pathname,
  mudaA: window.__vA.muted,
  tocando: !window.__vA.paused && !window.__vB.paused,
}));
ok(depois.principal === B, `a principal agora é ${depois.principal}`);
ok(depois.mesmosElementos, 'os mesmos dois <video> (nada foi desmontado)');
ok(depois.mesmosStreams, 'o mesmo srcObject em cada um');
ok(depois.wsNovos === 0, `nenhum WebSocket novo na troca (${depois.wsNovos})`);
ok(depois.tocando, 'os dois continuam tocando');
ok(depois.mudaA === true, 'quem virou secundária ficou muda');
ok(depois.caminho === `/${B}+${A}`, `a barra de endereço acompanha (${depois.caminho})`);
const principalDepois = await caixa('principal');
ok(principalDepois !== null && principalDepois.w >= 1200, `a nova principal ocupa o palco (${principalDepois?.w}px)`);

console.log('\n4. Lado a lado (L) e de volta');
await viewer.keyboard.press('l');
await viewer.waitForTimeout(400);
const lado = [await caixa('principal'), await caixa('secundaria')];
ok(
  lado.every((c) => c !== null && Math.abs(c.w - 640) <= 2),
  `metade cada (${lado.map((c) => c?.w).join(' + ')})`,
);
await viewer.keyboard.press('l');

console.log('\n5. Fechar a secundária (X) e pôr de novo pelo + TELA (A)');
await viewer.keyboard.press('x');
await viewer.waitForTimeout(600);
const sozinho = await viewer.evaluate(() => ({
  paineis: document.querySelectorAll('[data-canal]').length,
  caminho: location.pathname,
}));
ok(sozinho.paineis === 1 && sozinho.caminho === `/${B}`, `um painel só, em /${B} (${sozinho.paineis}, ${sozinho.caminho})`);
let saiu = false;
for (let i = 0; i < 10 && !saiu; i += 1) {
  await hostA.waitForTimeout(500);
  saiu = (await hostA.evaluate(() => window.__transport.peers().length)) === 0;
}
ok(saiu, 'fechar desconectou do anfitrião que saiu da tela');

await viewer.keyboard.press('a');
await viewer.waitForTimeout(300);
const recentes = await viewer.evaluate(() =>
  [...document.querySelectorAll('dialog[open] button')].map((b) => b.textContent?.trim()),
);
ok(recentes.includes(A), `o diálogo oferece ${A} nos recentes (${recentes.join(', ')})`);
await viewer.fill('dialog[open] input', A);
await viewer.keyboard.press('Enter');
let voltou = false;
for (let i = 0; i < 20 && !voltou; i += 1) {
  await viewer.waitForTimeout(1000);
  voltou = await chegou(A);
}
ok(voltou, `${A} voltou como secundária e está chegando`);
ok(
  (await viewer.evaluate(() => location.pathname)) === `/${B}+${A}`,
  'a barra de endereço tem os dois de novo',
);

const peersB = await hostB.evaluate(() => window.__transport.peers().length);
ok(peersB === 1, `o anfitrião da principal seguiu com 1 espectador o tempo todo (${peersB})`);

await browser.close();
console.log(process.exitCode ? '\n=== E2E FALHOU ===' : '\n=== E2E PASSOU ===');
