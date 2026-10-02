/**
 * O app EMPACOTADO, como a pessoa instala — com os fuses do Electron ligados
 * (S-03): sem `--inspect` nem RunAsNode, o Playwright não dirige o processo
 * principal, então este smoke olha só a página, pela porta de depuração do
 * Chromium. O resto (minimizar, bandeja, deep link) fica com
 * e2e/desktop*.e2e.mjs, que rodam o app não empacotado.
 *
 *   pnpm --filter @tela/desktop exec electron-builder --linux dir --publish never
 *   TELA_EXE=apps/desktop/release/linux-unpacked/tela node e2e/desktop-empacotado.e2e.mjs
 *
 * Abre UMA janela na tela por ~15 s.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const EXE = process.env.TELA_EXE;
const PORTA = Number(process.env.PORTA_CDP ?? 9334);
const SINAL = process.env.SINAL ?? 'ws://localhost:3333/signal';
if (!EXE) throw new Error('defina TELA_EXE');

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n1. Fuses: o binário não vira Node');
const comoNode = spawnSync(EXE, ['-e', 'console.log("VIROU NODE")'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 10_000,
});
ok(!`${comoNode.stdout}${comoNode.stderr}`.includes('VIROU NODE'), 'ELECTRON_RUN_AS_NODE não executa código');

const dados = mkdtempSync(join(tmpdir(), 'tela-empacotado-'));
const app = spawn(EXE, [`--remote-debugging-port=${PORTA}`, `--user-data-dir=${dados}`], {
  env: { ...process.env, TELA_NATIVO: '0', TELA_REGISTRAR_ESQUEMA: '0', TELA_DESKTOP_URL: 'https://mal.example' },
  stdio: 'ignore',
});
let navegador;
try {
  for (let i = 0; i < 60 && navegador === undefined; i += 1) {
    await esperar(250);
    navegador = await chromium.connectOverCDP(`http://127.0.0.1:${PORTA}`).catch(() => undefined);
  }
  if (!ok(navegador !== undefined, 'app abriu')) throw new Error('sem CDP');
  let pagina;
  for (let i = 0; i < 40 && pagina === undefined; i += 1) {
    pagina = navegador.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://'));
    if (pagina === undefined) await esperar(250);
  }

  console.log('\n2. Carga pelo app:// mesmo com TELA_DESKTOP_URL hostil (S-11)');
  ok(pagina !== undefined, `interface do app:// (${pagina?.url() ?? 'nenhuma'})`);
  if (pagina === undefined) throw new Error('sem página');
  await pagina.waitForSelector('#root *', { timeout: 15_000 });
  await esperar(1500);
  const estado = await pagina.evaluate(() => ({
    ponte: typeof window.telaDesktop === 'object',
    node: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
    texto: document.body.innerText.replace(/\s+/g, ' ').slice(0, 60),
  }));
  ok(estado.ponte, 'ponte do preload presente');
  ok(!estado.node, 'nada de Node na página');

  console.log('\n3. Sinalização aceita a origem do app');
  const ws = await pagina.evaluate((url) => new Promise((resolve) => {
    const s = new WebSocket(`${url}/emp${Math.random().toString(36).slice(2, 8)}`);
    s.onopen = () => { s.close(); resolve('aberto'); };
    s.onerror = () => resolve('erro');
    setTimeout(() => resolve('prazo'), 5000);
  }), SINAL);
  ok(ws === 'aberto', `WebSocket em ${SINAL} (${ws})`);
} catch (e) {
  ok(false, `interrompido: ${e.message.split('\n')[0]}`);
} finally {
  await navegador?.close().catch(() => undefined);
  app.kill('SIGTERM');
  await esperar(500);
  rmSync(dados, { recursive: true, force: true });
}
console.log(process.exitCode ? '\n=== EMPACOTADO FALHOU ===' : '\n=== EMPACOTADO PASSOU ===');
