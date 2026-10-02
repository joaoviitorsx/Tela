/**
 * Ao vivo DE DENTRO do app desktop: a interface no `app://tela`, o container
 * desktop, o transporte "um encode, N envios" com o worker carregado do
 * protocolo próprio e a CSP de produção — e um espectador web de verdade.
 *
 * Só a captura é trocada: `getDisplayMedia` no Wayland abre o diálogo do
 * sistema, que só uma pessoa clica, então a página recebe uma fonte sintética
 * 1920x1080@60 com cara de jogo. Todo o resto é o caminho real.
 *
 * Confere: o espectador decodifica a imagem real (>= 1280 de largura, fluida),
 * os senders do app codificam só a isca de 160 px (o "um encode" está ligado),
 * o link mostrado é a origem pública e o trilho trava ao vivo.
 *
 *   pnpm dev
 *   VITE_SIGNAL_URL=ws://localhost:3333/signal VITE_PUBLIC_ORIGIN=http://localhost:5173 \
 *     pnpm --filter @tela/web build:desktop
 *   pnpm --filter @tela/desktop build
 *   node e2e/desktop-ao-vivo.e2e.mjs      (TELA_EXE=... para o empacotado)
 *
 * Abre UMA janela na tela por ~1 min.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron, chromium } from 'playwright';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const ELECTRON = createRequire(`${RAIZ}apps/desktop/package.json`)('electron');
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const SEGUNDOS = Number(process.env.SEGUNDOS ?? 20);

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Roda na página do app antes de ir ao ar: fonte sintética e registro das conexões. */
function prepararHost() {
  const W = 1920;
  const H = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const mundo = document.createElement('canvas');
  mundo.width = 3200;
  mundo.height = 2000;
  const m = mundo.getContext('2d', { alpha: false });
  for (let i = 0; i < 3000; i += 1) {
    m.fillStyle = `hsl(${Math.random() * 360} 60% ${15 + Math.random() * 55}%)`;
    const s = 8 + Math.random() * 80;
    m.fillRect(Math.random() * 3200, Math.random() * 2000, s, s);
  }
  let t = 0;
  setInterval(() => {
    t += 1 / 60;
    ctx.drawImage(mundo, -600 + Math.sin(t) * 500, -400 + Math.cos(t * 0.8) * 350);
  }, 1000 / 60);
  navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(60);

  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = class extends Original {
    constructor(...a) {
      super(...a);
      window.__pcs.push(this);
    }
  };
}

let app;
let navegador;
try {
  const exe = process.env.TELA_EXE;
  app = await _electron.launch(
    exe
      ? { executablePath: exe, args: [], env: { ...process.env, TELA_NATIVO: '0', TELA_REGISTRAR_ESQUEMA: '0' } }
      : { executablePath: ELECTRON, args: ['.'], cwd: `${RAIZ}apps/desktop`, env: { ...process.env, TELA_NATIVO: '0', TELA_REGISTRAR_ESQUEMA: '0' } },
  );
  const host = await app.firstWindow();
  const erros = [];
  host.on('pageerror', (e) => erros.push(e.message));
  await host.waitForSelector('#slug', { timeout: 15_000 });
  await host.evaluate(prepararHost);

  console.log('\n1. O app vai ao ar pela interface');
  const slug = `app${Math.random().toString(36).slice(2, 8)}`;
  await host.locator('#slug').fill(slug);
  // O nome é conferido com debounce: o botão só habilita depois.
  await esperar(2000);
  for (const [rotulo, nome] of [['TRANSMITIR', /^TRANSMITIR$/], ['CONTINUAR', /CONTINUAR/], ['IR AO AR', /IR AO AR/]]) {
    const botao = host.getByRole('button', { name: nome }).last();
    await botao.waitFor({ timeout: 10_000 }).catch(() => undefined);
    if (!ok(await botao.isEnabled().catch(() => false), `botão ${rotulo}`)) {
      console.log(`   tela: ${(await host.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400)}`);
      throw new Error(`sem ${rotulo}`);
    }
    await botao.click();
    await esperar(1500);
  }
  await esperar(4000);
  const noAr = await host.evaluate(() => ({
    caminho: location.pathname,
    texto: document.body.innerText.replace(/\s+/g, ' '),
    trilho: [...document.querySelectorAll('nav button')].map((b) => b.disabled),
  }));
  ok(noAr.caminho === '/transmitir', `rota de transmissão (${noAr.caminho})`);
  ok(noAr.texto.includes(`${new URL(WEB).host}/${slug}`), 'o link mostrado é a origem pública, não app://');
  ok(noAr.trilho.length > 0 && noAr.trilho.every(Boolean), 'trilho travado ao vivo');

  console.log('\n1b. Link tela://assistir/<canal> ao vivo não tira a pessoa da transmissão');
  await app.evaluate(({ app: a }) => a.emit('second-instance', {}, ['tela', '--', '"tela://assistir/outrocanal"'], ''));
  await esperar(800);
  const comLink = await host.evaluate(() => ({
    caminho: location.pathname,
    aviso: document.body.innerText.includes('Você está ao vivo'),
    trilho: [...document.querySelectorAll('nav button')].map((b) => b.disabled),
  }));
  ok(comLink.caminho === '/transmitir', `continua em /transmitir (${comLink.caminho})`);
  ok(comLink.aviso, 'aviso "Você está ao vivo" aparece, sem bloquear');
  ok(comLink.trilho.every(Boolean), 'ASSISTIR e o resto do trilho seguem travados');

  console.log(`\n2. Espectador web em ${WEB}/${slug}`);
  navegador = await chromium.launch({ headless: true });
  const ctx = await navegador.newContext();
  await ctx.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Original {
      constructor(...a) {
        super(...a);
        window.__pcs.push(this);
      }
    };
  });
  const viewer = await ctx.newPage();
  await viewer.goto(`${WEB}/${slug}`, { waitUntil: 'domcontentloaded' });
  const ler = () => viewer.evaluate(async () => {
    const r = {};
    for (const pc of window.__pcs ?? []) {
      if (pc.connectionState !== 'connected') continue;
      (await pc.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          Object.assign(r, { w: s.frameWidth, h: s.frameHeight, dec: s.framesDecoded, cong: s.freezeCount ?? 0 });
        }
      });
    }
    return r;
  });
  await esperar(12_000);
  const antes = await ler();
  await esperar(SEGUNDOS * 1000);
  const depois = await ler();
  const fps = ((depois.dec ?? 0) - (antes.dec ?? 0)) / SEGUNDOS;
  console.log(`   espectador: ${depois.w}x${depois.h} · ${fps.toFixed(1)} fps · ${depois.cong} congelamento(s)`);
  ok((depois.w ?? 0) >= 1280, `espectador recebe a imagem real (${depois.w}x${depois.h})`);
  ok(fps >= 30, `fluida (${fps.toFixed(1)} fps decodificados)`);

  console.log('\n3. "Um encode, N envios" ligado no app');
  const iscas = await host.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs ?? []) {
      if (pc.connectionState !== 'connected') continue;
      (await pc.getStats()).forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') out.push(s.frameWidth);
      });
    }
    return out;
  });
  ok(iscas.length > 0 && iscas.every((w) => w <= 160), `os senders codificam só a isca (${iscas.join(', ')} px)`);
  ok(erros.length === 0, `página sem erro (${erros.join(' | ').slice(0, 200) || 'nenhum'})`);
} catch (e) {
  ok(false, `interrompido: ${e.message.split('\n')[0]}`);
} finally {
  await navegador?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
}
console.log(process.exitCode ? '\n=== AO VIVO NO APP FALHOU ===' : '\n=== AO VIVO NO APP PASSOU ===');
