/**
 * Custo da interface parada (TELA-026, §10.4 do plano).
 *
 * Mede, por tela ociosa, o tempo de CPU da página (`TaskDuration` do CDP) e as
 * animações infinitas rodando — separando as que estão numa camada invisível,
 * que são custo puro. E confere que montar a transmissão não duplica sessão:
 * um socket de sinalização por página, uma captura por TRANSMITIR.
 *
 * Roda contra o `pnpm dev` (StrictMode ligado: é onde a duplicação aparecia).
 * `getDisplayMedia` é um canvas; o WebGL é SwiftShader — o número da TV 3D
 * aqui é CPU fazendo trabalho de GPU e NÃO vale como custo real. O que vale é
 * a comparação: visível contra oculta, e antes contra depois.
 *
 *   node e2e/custo-interface.e2e.mjs        (JANELA=10000 ms por tela)
 */
import { chromium } from 'playwright';

const CHROME = process.env.CHROME ?? chromium.executablePath();
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const JANELA = Number(process.env.JANELA ?? 10_000);

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

/** Captura falsa e espiões de socket/captura, antes de qualquer script da página. */
function espioes() {
  window.__ws = [];
  const Original = window.WebSocket;
  window.WebSocket = class extends Original {
    constructor(...args) {
      super(...args);
      window.__ws.push(this);
    }
  };
  window.__capturas = 0;
  navigator.mediaDevices.getDisplayMedia = async () => {
    window.__capturas += 1;
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    const g = c.getContext('2d');
    let f = 0;
    setInterval(() => {
      f += 1;
      g.fillStyle = `hsl(${f % 360} 80% 50%)`;
      g.fillRect(0, 0, 1280, 720);
    }, 33);
    return c.captureStream(30);
  };
  localStorage.setItem('tela.apelido', 'medidor');
}

const slug = () => `custo${Math.random().toString(36).slice(2, 7)}`;

async function medir(nome, preparar) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(espioes);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await preparar(page);
  await page.waitForTimeout(2000);
  const metricas = async () =>
    Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const antes = await metricas();
  await page.waitForTimeout(JANELA);
  const depois = await metricas();
  const animacoes = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity)
      .map((a) => {
        // Só os ANCESTRAIS: o próprio LED alterna a opacidade ao piscar.
        let e = a.effect?.target?.parentElement ?? null;
        while (e !== null) {
          if (getComputedStyle(e).opacity === '0') return { nome: a.animationName, invisivel: true };
          e = e.parentElement;
        }
        return { nome: a.animationName, invisivel: false };
      }),
  );
  const sessao = await page.evaluate(() => {
    const sinal = window.__ws.filter((w) => w.url.includes('/signal'));
    return { sockets: sinal.filter((w) => w.readyState <= 1).length, capturas: window.__capturas };
  });
  const porS = (k) => ((depois[k] - antes[k]) * 1000) / (JANELA / 1000);
  const r = { nome, cpu: porS('TaskDuration'), script: porS('ScriptDuration'), animacoes, ...sessao };
  console.log(
    `  ${nome.padEnd(34)} CPU ${r.cpu.toFixed(1).padStart(6)} ms/s  script ${r.script.toFixed(1).padStart(5)}` +
      `  animações ${animacoes.length} (${animacoes.filter((a) => a.invisivel).length} invisíveis)` +
      `  sockets ${sessao.sockets}  capturas ${sessao.capturas}`,
  );
  await ctx.close();
  return r;
}

const naHome = async (p) => {
  await p.goto(`${WEB}/?abertura=0`, { waitUntil: 'networkidle' });
  await p.fill('#slug', slug());
};
const aoVivo = async (p) => {
  await naHome(p);
  await p.getByRole('button', { name: /^TRANSMITIR/ }).click();
  await p.waitForTimeout(600);
  await p.getByRole('button', { name: /CONTINUAR/ }).click();
  await p.waitForTimeout(600);
  await p.getByRole('button', { name: /IR AO AR/ }).click();
  await p.waitForSelector('text=NO AR', { timeout: 15_000 });
  await p.mouse.move(700, 400);
};

console.log('\n1. Custo por tela ociosa');
const tv = await medir('home passo 01 (TV 3D)', naHome);
const tvOculta = await medir('home passo 01, aba oculta', async (p) => {
  await naHome(p);
  await p.waitForTimeout(1500);
  await p.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
});
const tvFora = await medir('home passo 01, TV fora da tela', async (p) => {
  await naHome(p);
  await p.waitForTimeout(1500);
  await p.evaluate(() => {
    document.querySelector('canvas').style.transform = 'translateY(-5000px)';
  });
});
const passo2 = await medir('home passo 02', async (p) => {
  await naHome(p);
  await p.getByRole('button', { name: /^TRANSMITIR/ }).click();
});
const espera = await medir('espectador esperando sinal', async (p) => {
  await p.goto(`${WEB}/${slug()}#k=${'c'.repeat(22)}`, { waitUntil: 'networkidle' });
});
const aceso = await medir('ao vivo, console aceso', aoVivo);
const apagado = await medir('ao vivo, console apagado (placa)', async (p) => {
  await aoVivo(p);
  await p.waitForTimeout(6500);
});

console.log('\n2. Critérios');
ok(tvOculta.cpu < tv.cpu * 0.05, `TV 3D para com a aba oculta (${tvOculta.cpu.toFixed(1)} contra ${tv.cpu.toFixed(1)} ms/s)`);
ok(tvFora.cpu < tv.cpu * 0.05, `TV 3D para fora da tela (${tvFora.cpu.toFixed(1)} ms/s)`);
ok(passo2.cpu < 2, `sem TV, a home fica parada (${passo2.cpu.toFixed(1)} ms/s)`);
for (const r of [tv, passo2, espera, aceso, apagado]) {
  ok(r.animacoes.every((a) => !a.invisivel), `${r.nome}: nenhuma animação infinita em camada invisível`);
}
ok(aceso.capturas === 1, `TRANSMITIR pede a captura UMA vez, mesmo em StrictMode (${aceso.capturas})`);
// Esperando sinal, o socket fecha entre uma consulta e outra: 0 ou 1, nunca 2.
ok(aceso.sockets === 1 && espera.sockets <= 1, `no máximo um socket de sinalização por página (${aceso.sockets}, ${espera.sockets})`);

await browser.close();
console.log(process.exitCode ? '\n=== CUSTO FALHOU ===' : '\n=== CUSTO PASSOU ===');
