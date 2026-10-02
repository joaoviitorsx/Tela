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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Dados à parte (ajustes, autostart): o e2e nunca toca os da pessoa.
const DADOS = mkdtempSync(join(tmpdir(), 'tela-e2e-'));
// `BANDEJA=0` testa o app SEM bandeja: fechar ao vivo vira o modo compacto.
const BANDEJA = process.env.BANDEJA ?? '1';
const AMBIENTE = { ...process.env, TELA_NATIVO: '0', TELA_REGISTRAR_ESQUEMA: '0', TELA_USERDATA: DADOS, TELA_BANDEJA: BANDEJA };

let app;
let navegador;
try {
  const exe = process.env.TELA_EXE;
  app = await _electron.launch(
    exe
      // Empacotado ignora TELA_USERDATA (S-11): os dados à parte vão pela flag do Chromium.
      ? { executablePath: exe, args: [`--user-data-dir=${DADOS}`], env: AMBIENTE }
      : { executablePath: ELECTRON, args: ['.'], cwd: `${RAIZ}apps/desktop`, env: AMBIENTE },
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
    trilho: [...document.querySelectorAll('nav button')].map((b) => ({ texto: b.textContent.trim(), travado: b.disabled || b.getAttribute('aria-disabled') === 'true' })),
  }));
  ok(noAr.caminho === '/transmitir', `rota de transmissão (${noAr.caminho})`);
  ok(noAr.texto.includes(`${new URL(WEB).host}/${slug}`), 'o link mostrado é a origem pública, não app://');
  // Ao vivo a tecla da transmissão vira "NO AR"; as outras ficam aria-disabled
  // (focáveis, com a explicação lida por teclado e toque — auditoria D-02).
  // AJUSTES (D4) e DIAG (D-04) abrem painéis, não rotas: nunca travam.
  const travadoAoVivo = (t) => t.some((i) => /NO AR/.test(i.texto)) && t.filter((i) => !/NO AR|AJUSTES|DIAG/.test(i.texto)).every((i) => i.travado);
  ok(travadoAoVivo(noAr.trilho), `trilho travado ao vivo (${JSON.stringify(noAr.trilho)})`);
  // E clicar numa tecla travada não tira a pessoa da transmissão.
  await host.getByRole('button', { name: /ASSISTIR/ }).first().click({ force: true });
  await esperar(400);
  ok((await host.evaluate(() => location.pathname)) === '/transmitir', 'tecla travada não navega');

  console.log('\n1b. Link tela://assistir/<canal> ao vivo não tira a pessoa da transmissão');
  await app.evaluate(({ app: a }) => a.emit('second-instance', {}, ['tela', '--', '"tela://assistir/outrocanal"'], ''));
  await esperar(800);
  const comLink = await host.evaluate(() => ({
    caminho: location.pathname,
    aviso: document.body.innerText.includes('Você está ao vivo'),
    trilho: [...document.querySelectorAll('nav button')].map((b) => ({ texto: b.textContent.trim(), travado: b.disabled || b.getAttribute('aria-disabled') === 'true' })),
  }));
  ok(comLink.caminho === '/transmitir', `continua em /transmitir (${comLink.caminho})`);
  ok(comLink.aviso, 'aviso "Você está ao vivo" aparece, sem bloquear');
  ok(travadoAoVivo(comLink.trilho), 'ASSISTIR e o resto do trilho seguem travados');

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
  console.log('\n4. Segundo plano (D4): painel NO AR, compacto, fechar, suspensão');
  const janelaInfo = () => app.evaluate(({ BrowserWindow }) => {
    const j = BrowserWindow.getAllWindows()[0];
    return { visivel: j.isVisible(), largura: j.getSize()[0], altura: j.getSize()[1], resizavel: j.isResizable() };
  });
  const painel = host.getByRole('region', { name: 'Transmissão no ar' });
  ok(await painel.isVisible(), 'o painel NO AR aparece no pé da janela');
  const textoDoPainel = (await painel.textContent()) ?? '';
  ok(/NO AR/.test(textoDoPainel) && /\d+\/\d+/.test(textoDoPainel), `painel mostra NO AR e n/N (${textoDoPainel.replace(/\s+/g, ' ').slice(0, 120)})`);
  ok(/direta|TURN|mista|—/.test(textoDoPainel) && /ENCODER/.test(textoDoPainel), 'painel mostra rota e encoder');

  // Compacto pelo IPC: a MESMA janela encolhe; a transmissão e a rota seguem.
  const grande = await janelaInfo();
  await host.evaluate(() => window.telaDesktop.pedirModo('compacto'));
  await esperar(1200);
  const compacto = await janelaInfo();
  ok(compacto.largura <= 480 && compacto.altura <= 160, `a janela encolheu (${grande.largura}x${grande.altura} → ${compacto.largura}x${compacto.altura})`);
  ok(!compacto.resizavel, 'compacto não é redimensionável');
  ok(await host.getByRole('region', { name: /janela compacta/ }).isVisible(), 'a faixa compacta aparece');
  ok((await host.evaluate(() => document.documentElement.dataset.aba)) === 'oculta', 'compacto usa o modo escondido (animações paradas)');
  ok((await host.evaluate(() => location.pathname)) === '/transmitir', 'a rota da transmissão continua montada');
  await host.getByRole('button', { name: 'EXPANDIR' }).click();
  await esperar(1200);
  const volta = await janelaInfo();
  ok(volta.largura === grande.largura && volta.altura === grande.altura && volta.resizavel, `EXPANDIR devolve o tamanho (${volta.largura}x${volta.altura})`);
  ok(await painel.isVisible(), 'o painel NO AR volta');

  // O "Encerrar" da bandeja pede à interface o fluxo dela: com plateia, a confirmação.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('tela:pedir-encerrar'));
  // Por papel: só o diálogo ABERTO entra na árvore (o da rota e o da moldura ficam fechados).
  const confirmacao = host.getByRole('heading', { name: 'ENCERRAR A TRANSMISSÃO?' });
  await confirmacao.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
  ok(await confirmacao.isVisible(), 'encerrar pela bandeja abre a confirmação (há espectador)');
  await host.getByRole('button', { name: 'CONTINUAR NO AR' }).last().click();
  await esperar(500);
  ok((await host.evaluate(() => location.pathname)) === '/transmitir' && (await painel.isVisible()), 'continuar no ar mantém a transmissão');

  // Moldura própria (§11): ao vivo a barra mostra o link, e o botão Fechar (Linux)
  // passa pela MESMA política do fechar nativo — a primeira pergunta vem dele.
  const barra = host.getByRole('group', { name: 'Barra da janela' });
  ok(await barra.isVisible(), 'a barra da janela está à vista ao vivo');
  ok(/tela\.gg|localhost|\//.test(await barra.innerText()), `a barra mostra o link do canal (${(await barra.innerText()).replace(/\s+/g, ' ')})`);

  // Fechar a janela ao vivo: pergunta; continuar esconde (bandeja) ou vira compacto (sem ela).
  if (process.platform === 'linux') await barra.getByRole('button', { name: 'Fechar' }).click();
  else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const pergunta = host.getByText('CONTINUAR TRANSMITINDO EM SEGUNDO PLANO?');
  await pergunta.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
  ok(await pergunta.isVisible(), 'fechar ao vivo pergunta "Continuar transmitindo em segundo plano?"');
  await host.keyboard.press('Escape');
  await esperar(500);
  ok((await janelaInfo()).visivel && !(await pergunta.isVisible()), 'Esc cancela: a janela fica como está');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await pergunta.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
  await host.getByRole('checkbox', { name: /Lembrar minha escolha/ }).check();
  await host.getByRole('button', { name: 'CONTINUAR NO AR' }).last().click();
  await esperar(1200);
  const aposFechar = await janelaInfo();
  if (BANDEJA === '1') {
    ok(!aposFechar.visivel, 'com bandeja: a janela ESCONDE (não destrói) e a transmissão segue');
    ok((await host.evaluate(() => document.documentElement.dataset.aba)) === 'oculta', 'escondida: modo escondido avisado à página');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  } else {
    ok(aposFechar.visivel && aposFechar.largura <= 480, 'SEM bandeja: vira o modo compacto, nunca some');
    await host.getByRole('button', { name: 'EXPANDIR' }).click();
  }
  await esperar(1200);
  ok((await host.evaluate(() => location.pathname)) === '/transmitir', 'a transmissão sobreviveu a fechar a janela');
  ok(JSON.parse(readFileSync(join(DADOS, 'ajustes.json'), 'utf8')).aoFecharAoVivo === 'segundo-plano', 'a escolha foi lembrada em userData');
  // Lembrada: fechar de novo não pergunta mais.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await esperar(1200);
  ok(!(await pergunta.isVisible()), 'lembrada: fechar de novo não pergunta');
  if (BANDEJA === '1') await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  else await host.getByRole('button', { name: 'EXPANDIR' }).click().catch(() => undefined);
  await esperar(1200);

  // Suspensão: encerra com o motivo explícito, que fica à vista na volta.
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await host.getByText(/entrou em suspensão/).waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
  ok(await host.getByText('A transmissão foi encerrada porque o computador entrou em suspensão.').isVisible(), 'suspender encerra com o motivo explícito');
  ok(!(await painel.isVisible().catch(() => false)), 'o painel NO AR some: não está mais no ar');

  ok(erros.length === 0, `página sem erro (${erros.join(' | ').slice(0, 200) || 'nenhum'})`);
} catch (e) {
  ok(false, `interrompido: ${e.message.split('\n')[0]}`);
} finally {
  await navegador?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  rmSync(DADOS, { recursive: true, force: true });
}
console.log(process.exitCode ? '\n=== AO VIVO NO APP FALHOU ===' : '\n=== AO VIVO NO APP PASSOU ===');
