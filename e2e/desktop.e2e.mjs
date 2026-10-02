/**
 * O app desktop (D1) de verdade: o Electron compilado em dist/, a interface
 * pelo `app://tela`, dirigido pelo `_electron` do Playwright — que também roda
 * código no processo principal, o único jeito de minimizar a janela.
 *
 * Confere o que só aparece com o Electron rodando: a página carrega do
 * protocolo próprio sem violar a CSP, a ponte do preload existe e não vaza
 * Node, o trilho troca de rota sem recarregar, a janela minimizada pausa as
 * animações (modo escondido, §3.2) e a sinalização aceita a origem do app.
 *
 * Não entra ao vivo: `getDisplayMedia` no Wayland abre o diálogo do sistema,
 * que só uma pessoa clica. Abre UMA janela na tela por ~15 s.
 *
 *   pnpm dev                                                    (signaling :3333)
 *   VITE_SIGNAL_URL=ws://localhost:3333/signal VITE_PUBLIC_ORIGIN=http://localhost:5173 \
 *     pnpm --filter @tela/web build:desktop
 *   pnpm --filter @tela/desktop build
 *   node e2e/desktop.e2e.mjs
 *
 * Empacotado: `pnpm --filter @tela/desktop exec electron-builder --linux dir`
 * e `TELA_EXE=apps/desktop/release/linux-unpacked/tela node e2e/desktop.e2e.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(`${RAIZ}apps/desktop/package.json`);
const ELECTRON = require('electron');
const SINAL = process.env.SINAL ?? 'ws://localhost:3333/signal';

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let app;
try {
  // TELA_EXE: o app EMPACOTADO (ex.: apps/desktop/release/linux-unpacked/tela),
  // que carrega o main de dentro do asar e o front de resources/web.
  const exe = process.env.TELA_EXE;
  app = await _electron.launch(
    exe
      ? { executablePath: exe, args: [], env: { ...process.env, TELA_NATIVO: '0' } }
      : { executablePath: ELECTRON, args: ['.'], cwd: `${RAIZ}apps/desktop`, env: { ...process.env, TELA_NATIVO: '0' } },
  );
  const page = await app.firstWindow();
  await page.waitForURL(/^app:\/\//, { timeout: 10_000 }).catch(() => undefined);
  if (!ok(page.url().startsWith('app://'), `página no app:// (${page.url()})`)) throw new Error('sem página');

  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(e.message));
  await page.evaluate(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    window.__marca = 'sem-recarregar';
  });
  await page.waitForSelector('#root *', { timeout: 10_000 });
  await esperar(2500);

  console.log('\n1. Carga e ponte');
  const estado = await page.evaluate(() => ({
    caminho: location.pathname,
    ponte: typeof window.telaDesktop === 'object' ? {
      plataforma: window.telaDesktop.plataforma,
      versao: window.telaDesktop.versao,
      chaves: Object.keys(window.telaDesktop).sort(),
    } : null,
    node: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
    baixarApp: document.body.innerText.includes("BAIXAR APP"),
    texto: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120),
  }));
  console.log(`   ${JSON.stringify(estado)}`);
  ok(estado.caminho === '/', `rota inicial é a home (${estado.caminho})`);
  ok(estado.ponte !== null && estado.ponte.plataforma === process.platform, `ponte presente (${estado.ponte?.plataforma}, v${estado.ponte?.versao})`);
  ok(JSON.stringify(estado.ponte?.chaves) === JSON.stringify(['abrirNoNavegador', 'aoMudarVisibilidade', 'capacidades', 'capturaNativa', 'escolherFonte', 'listarFontes', 'plataforma', 'versao']), 'a ponte expõe só as operações nomeadas');
  ok(!estado.node, 'nada de Node na página');
  ok(!estado.baixarApp, 'sem BAIXAR APP dentro do próprio app');

  console.log('\n2. Trilho: troca de rota sem recarregar');
  await page.getByRole('button', { name: /canal/i }).first().click();
  await esperar(500);
  const naRecuperacao = await page.evaluate(() => ({ caminho: location.pathname, marca: window.__marca }));
  ok(naRecuperacao.caminho === '/recuperar', `CANAL abre /recuperar (${naRecuperacao.caminho})`);
  ok(naRecuperacao.marca === 'sem-recarregar', 'sem recarregar a página');
  await page.getByRole('button', { name: /transmitir/i }).first().click();
  await esperar(500);
  ok((await page.evaluate(() => location.pathname)) === '/', 'TRANSMITIR volta à home');

  console.log('\n3. Modo escondido');
  ok((await page.evaluate(() => document.documentElement.dataset.aba)) === 'visivel', 'visível: animações rodando');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
  await esperar(800);
  ok((await page.evaluate(() => document.documentElement.dataset.aba)) === 'oculta', 'minimizada: data-aba="oculta" (animações pausadas)');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
  await esperar(800);
  ok((await page.evaluate(() => document.documentElement.dataset.aba)) === 'visivel', 'restaurada: volta a visível');

  console.log('\n4. Sinalização aceita a origem app://tela');
  const ws = await page.evaluate((url) => new Promise((resolve) => {
    const s = new WebSocket(`${url}/smoke${Math.random().toString(36).slice(2, 8)}`);
    s.onopen = () => { s.close(); resolve('aberto'); };
    s.onerror = () => resolve('erro');
    setTimeout(() => resolve('prazo'), 5000);
  }), SINAL);
  ok(ws === 'aberto', `WebSocket em ${SINAL} (${ws})`);

  console.log('\n5. Sem erro nem violação de CSP');
  const csp = await page.evaluate(() => window.__csp);
  // Fonte do Google offline não é defeito do app; o resto é.
  const relevantes = erros.filter((e) => !/fonts\.(googleapis|gstatic)/.test(e));
  ok(csp.length === 0, `CSP sem violação (${csp.join(' | ') || 'nenhuma'})`);
  ok(relevantes.length === 0, `console sem erro (${relevantes.join(' | ').slice(0, 300) || 'nenhum'})`);
} catch (e) {
  ok(false, `smoke interrompido: ${e.message}`);
} finally {
  await app?.close().catch(() => undefined);
}
console.log(process.exitCode ? '\n=== DESKTOP FALHOU ===' : '\n=== DESKTOP PASSOU ===');
