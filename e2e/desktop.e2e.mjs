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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Dados à parte: ajustes, token e AUTOSTART nunca tocam os da pessoa (`TELA_USERDATA`).
const DADOS = mkdtempSync(join(tmpdir(), 'tela-e2e-'));
// `TELA_BANDEJA=1` força a bandeja; `BANDEJA=0 node e2e/...` testa o app sem ela.
const BANDEJA = process.env.BANDEJA ?? '1';
const AMBIENTE = { ...process.env, TELA_NATIVO: '0', TELA_REGISTRAR_ESQUEMA: '0', TELA_USERDATA: DADOS, TELA_BANDEJA: BANDEJA };


let app;
try {
  // TELA_EXE: o app EMPACOTADO (ex.: apps/desktop/release/linux-unpacked/tela),
  // que carrega o main de dentro do asar e o front de resources/web.
  const exe = process.env.TELA_EXE;
  app = await _electron.launch(
    exe
      // Empacotado ignora TELA_USERDATA (S-11): os dados à parte vão pela flag do Chromium.
      ? { executablePath: exe, args: [`--user-data-dir=${DADOS}`], env: AMBIENTE }
      : { executablePath: ELECTRON, args: ['.'], cwd: `${RAIZ}apps/desktop`, env: AMBIENTE },
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
  // A abertura 3D roda na primeira visita da sessão, e o toque que a pula é
  // barrado de propósito: clicar no trilho durante a cena não faz nada. Uma
  // pessoa espera a cena; o teste também (o canvas sai do DOM no fim).
  await page.waitForFunction(() => document.querySelector('canvas.fixed.inset-0') === null, null, { timeout: 15_000 }).catch(() => undefined);
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
  const CHAVES = ['abrirNoNavegador', 'ajustes', 'aoAbrirCanal', 'aoAlternarOculto', 'aoAtalhoOculto', 'aoMudarAtualizacao', 'aoMudarModo', 'aoMudarVisibilidade', 'aoPedirEncerrar', 'aoPedirParar', 'aoPerguntarFechar', 'atualizacao', 'capacidades', 'capturaNativa', 'enviarEstadoAoVivo', 'escolherFonte', 'janela', 'listarFontes', 'paradaConcluida', 'pedirModo', 'plataforma', 'reiniciarEAtualizar', 'responderFechar', 'salvarAjustes', 'som', 'verificarAtualizacao', 'versao'];
  // O que importa de verdade: nada genérico de IPC atravessa a ponte (§3.4).
  const GENERICAS = ['send', 'sendSync', 'invoke', 'on', 'once', 'ipcRenderer', 'require', 'postMessage'];
  ok(!(estado.ponte?.chaves ?? []).some((c) => GENERICAS.includes(c)), 'nenhuma operação genérica de IPC na ponte');
  ok(JSON.stringify(estado.ponte?.chaves) === JSON.stringify(CHAVES), `a ponte expõe só as operações nomeadas (${JSON.stringify(estado.ponte?.chaves)})`);
  ok(!estado.node, 'nada de Node na página');
  ok(!estado.baixarApp, 'sem BAIXAR APP dentro do próprio app');

  console.log('\n2. Trilho: troca de rota sem recarregar');
  await page.getByRole('button', { name: /^CÓDIGO$/ }).first().click();
  await esperar(500);
  const naRecuperacao = await page.evaluate(() => ({ caminho: location.pathname, marca: window.__marca }));
  ok(naRecuperacao.caminho === '/recuperar', `CÓDIGO abre /recuperar (${naRecuperacao.caminho})`);
  ok(naRecuperacao.marca === 'sem-recarregar', 'sem recarregar a página');
  await page.getByRole('button', { name: /transmitir/i }).first().click();
  await esperar(500);
  ok((await page.evaluate(() => location.pathname)) === '/', 'TRANSMITIR volta à home');

  console.log('\n2b. ASSISTIR: cola o link e abre o canal');
  const assistir = page.getByRole('button', { name: /^ASSISTIR$/ }).first();
  ok(await assistir.isVisible(), 'o trilho tem ASSISTIR');
  await assistir.click();
  await esperar(400);
  const campo = page.getByLabel('LINK OU NOME DO CANAL');
  // `isVisible` não espera: logo depois de uma troca de rota o diálogo pode
  // abrir uns quadros depois do clique.
  await campo.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
  if (!ok(await campo.isVisible(), 'o painel ASSISTIR abre com o campo')) {
    console.log('   diagnóstico:', JSON.stringify(await page.evaluate(() => ({
      caminho: location.pathname,
      abertos: [...document.querySelectorAll('dialog')].filter((d) => d.open).map((d) => d.querySelector('h2')?.textContent),
      noPonto: (() => {
        const b = [...document.querySelectorAll('nav button')].find((x) => x.textContent.includes('ASSISTIR'));
        if (!b) return 'sem botão';
        const r = b.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML.slice(0, 100);
      })(),
    }))));
  }
  await campo.fill('???');
  await page.getByRole('button', { name: /^ASSISTIR$/ }).last().click();
  await esperar(300);
  ok((await page.evaluate(() => location.pathname)) === '/', 'entrada inválida não navega');
  await campo.fill('https://tela.gg/maria');
  await page.getByRole('button', { name: /^ASSISTIR$/ }).last().click();
  await esperar(800);
  const noCanal = await page.evaluate(() => ({
    caminho: location.pathname,
    marca: window.__marca,
    ativo: document.querySelector('nav button[aria-current="page"]')?.textContent ?? null,
  }));
  ok(noCanal.caminho === '/maria', `o link colado abre /maria (${noCanal.caminho})`);
  ok(noCanal.marca === 'sem-recarregar', 'sem recarregar a página');
  ok(/ASSISTIR/.test(noCanal.ativo ?? ''), `ASSISTIR aceso no canal (${noCanal.ativo})`);

  console.log('\n2c. Deep link tela://assistir/<canal> (second-instance, formato Windows)');
  // O main trata `second-instance`, `open-url` e o argv do primeiro lançamento
  // pelo MESMO caminho; emitir o evento exercita o do Windows/Linux sem abrir
  // outro processo e sem registrar o esquema na máquina.
  await app.evaluate(({ app: a }) => a.emit('second-instance', {}, ['Tela.exe', '--', '"tela://assistir/joao?x=1"'], ''));
  await esperar(800);
  const porLink = await page.evaluate(() => ({ caminho: location.pathname, marca: window.__marca }));
  ok(porLink.caminho === '/joao', `o link leva a /joao (${porLink.caminho})`);
  ok(porLink.marca === 'sem-recarregar', 'sem recarregar a página');
  await app.evaluate(({ app: a }) => a.emit('second-instance', {}, ['tela', 'tela://assistir/../recuperar', 'tela://assistir/pedro'], ''));
  await esperar(500);
  ok((await page.evaluate(() => location.pathname)) === '/joao', 'link malformado é ignorado');
  await page.getByRole('button', { name: /transmitir/i }).first().click();
  await esperar(500);

  console.log('\n3. Modo escondido');
  ok((await page.evaluate(() => document.documentElement.dataset.aba)) === 'visivel', 'visível: animações rodando');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
  await esperar(800);
  ok((await page.evaluate(() => document.documentElement.dataset.aba)) === 'oculta', 'minimizada: data-aba="oculta" (animações pausadas)');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
  await esperar(800);
  ok((await page.evaluate(() => document.documentElement.dataset.aba)) === 'visivel', 'restaurada: volta a visível');

  console.log('\n3b. Moldura própria da janela (§11)');
  const barra = page.getByRole('group', { name: 'Barra da janela' });
  ok(await barra.isVisible(), 'a barra da janela existe');
  const medida = await barra.evaluate((el) => ({ h: el.getBoundingClientRect().height, drag: getComputedStyle(el).getPropertyValue('-webkit-app-region') }));
  ok(medida.h === 32, `a barra tem 32 px (${medida.h})`);
  if (process.platform === 'linux') {
    ok(medida.drag === 'drag', `a barra é região de arrasto (${medida.drag})`);
    for (const nome of ['Minimizar', 'Maximizar', 'Fechar']) {
      ok(await barra.getByRole('button', { name: nome }).isVisible(), `botão ${nome}`);
    }
    ok((await barra.getByRole('button', { name: 'Fechar' }).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))) === 'no-drag', 'os botões são no-drag');
    // Minimizar de verdade, pelo botão.
    await barra.getByRole('button', { name: 'Minimizar' }).click();
    await esperar(800);
    ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()), 'o botão minimiza a janela');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
    await esperar(800);
    // Fechar passa pela política de D4: o `close` da janela dispara. Um ouvinte
    // posterior ao do main cancela, para o teste não derrubar o app (fora do ar a política é "sair").
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.__fechou = 0;
      BrowserWindow.getAllWindows()[0]?.once('close', (e) => { e.preventDefault(); globalThis.__fechou += 1; });
    });
    await barra.getByRole('button', { name: 'Fechar' }).click();
    await esperar(600);
    ok((await app.evaluate(() => globalThis.__fechou)) === 1, 'o botão Fechar dispara o `close` da janela (a mesma política do fechar nativo)');
  } else {
    ok((await barra.getByRole('button').count()) === 0, 'fora do Linux os botões são do sistema (overlay)');
  }

  console.log('\n4. Sinalização aceita a origem app://tela');
  const ws = await page.evaluate((url) => new Promise((resolve) => {
    const s = new WebSocket(`${url}/smoke${Math.random().toString(36).slice(2, 8)}`);
    s.onopen = () => { s.close(); resolve('aberto'); };
    s.onerror = () => resolve('erro');
    setTimeout(() => resolve('prazo'), 5000);
  }), SINAL);
  ok(ws === 'aberto', `WebSocket em ${SINAL} (${ws})`);

  console.log('\n4b. Segundo plano: ajustes, autostart e validação do IPC (D4)');
  const ajustes0 = await page.evaluate(() => window.telaDesktop.ajustes());
  ok(ajustes0.ajustes.iniciarComSistema === false && ajustes0.ajustes.aoFecharAoVivo === 'perguntar', `padrões: nada liga sozinho (${JSON.stringify(ajustes0.ajustes)})`);
  ok(ajustes0.bandeja === (BANDEJA === '1'), `bandeja ${ajustes0.bandeja ? 'presente' : 'ausente'}, como forçado`);

  // Pelo painel, como a pessoa: AJUSTES → caixa com rótulo.
  await page.getByRole('button', { name: /^AJUSTES$/ }).click();
  const caixaAutostart = page.getByRole('checkbox', { name: 'Iniciar com o sistema' });
  await caixaAutostart.waitFor({ state: 'visible', timeout: 3000 });
  // Controlada: a caixa só marca quando o main DEVOLVE o ajuste gravado.
  await caixaAutostart.click();
  await esperar(600);
  ok(await caixaAutostart.isChecked(), 'a caixa mostra o que o main gravou');
  const arquivoAutostart = join(DADOS, 'autostart', 'tela.desktop');
  if (process.platform === 'linux') {
    ok(existsSync(arquivoAutostart), 'iniciar com o sistema: o .desktop foi escrito na pasta TEMPORÁRIA');
    const texto = existsSync(arquivoAutostart) ? readFileSync(arquivoAutostart, 'utf8') : '';
    ok(/^Exec=.*--oculto$/m.test(texto), 'o autostart abre oculto (--oculto)');
  }
  ok(JSON.parse(readFileSync(join(DADOS, 'ajustes.json'), 'utf8')).iniciarComSistema === true, 'ajustes.json em userData grava a escolha');
  await caixaAutostart.click();
  await esperar(600);
  if (process.platform === 'linux') ok(!existsSync(arquivoAutostart), 'desligar remove o .desktop');
  await page.getByRole('button', { name: /^FECHAR$/ }).click();

  // O main valida: lixo não vira ajuste, estado inválido não derruba nada.
  const depoisDoLixo = await page.evaluate(async () => {
    window.telaDesktop.enviarEstadoAoVivo({ noAr: true, assistindo: -1, capacidade: 'x', link: 'javascript:alert(1)' });
    window.telaDesktop.pedirModo('gigante');
    window.telaDesktop.responderFechar({ acao: 'sim', lembrar: true });
    return (await window.telaDesktop.salvarAjustes({ iniciarComSistema: 'sim', aoFecharAoVivo: 'tchau' })).ajustes;
  });
  ok(depoisDoLixo.iniciarComSistema === false && depoisDoLixo.aoFecharAoVivo === 'perguntar', 'ajustes com tipo errado são ignorados');
  // Compacto fora do ar não existe: o pedido é recusado e a janela fica como está.
  const antes = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize());
  await page.evaluate(() => window.telaDesktop.pedirModo('compacto'));
  await esperar(500);
  const depois = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize());
  ok(antes[0] === depois[0] && antes[1] === depois[1], `compacto fora do ar é recusado (${depois[0]}x${depois[1]})`);

  console.log('\n5. Sem erro nem violação de CSP');
  const csp = await page.evaluate(() => window.__csp);
  // Fonte do Google offline não é defeito do app; o resto é.
  const relevantes = erros.filter((e) => !/fonts\.(googleapis|gstatic)/.test(e));
  ok(csp.length === 0, `CSP sem violação (${csp.join(' | ') || 'nenhuma'})`);
  ok(relevantes.length === 0, `console sem erro (${relevantes.join(' | ').slice(0, 300) || 'nenhum'})`);

  console.log('\n6. Fechar a janela FORA do ar');
  if (BANDEJA === '1') {
    await page.evaluate(() => window.telaDesktop.salvarAjustes({ fecharEmSegundoPlano: true }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await esperar(600);
    ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() === false), 'com "fechar = segundo plano" e bandeja, fechar ESCONDE (não destrói)');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    await esperar(600);
    ok((await page.evaluate(() => document.documentElement.dataset.aba)) === 'visivel', 'mostrar de novo: a interface volta a visível');
    await page.evaluate(() => window.telaDesktop.salvarAjustes({ fecharEmSegundoPlano: false }));
  }
  // O padrão: fora do ar, fechar SAI.
  const saiu = new Promise((resolver) => app.once('close', () => resolver(true)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  ok(await Promise.race([saiu, esperar(8000).then(() => false)]), 'fora do ar e sem "segundo plano", fechar encerra o app');
} catch (e) {
  ok(false, `smoke interrompido: ${e.message}`);
} finally {
  await app?.close().catch(() => undefined);
  rmSync(DADOS, { recursive: true, force: true });
}
console.log(process.exitCode ? '\n=== DESKTOP FALHOU ===' : '\n=== DESKTOP PASSOU ===');
