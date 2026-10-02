/**
 * Quanto custa o codificador único do app, por processo do Chromium (D9,
 * docs/desktop/D9-gpu-windows.md): a régua para dizer se a GPU está mesmo
 * codificando e quanto ela poupa da CPU do jogo.
 *
 * Roda o `CodificadorWebCodecs` REAL (servido pelo Vite) sobre uma fonte
 * 1920×1080 a 60 fps desenhada num canvas, em três cenas, cada uma numa aba
 * nova:
 *
 *   fonte     só a fonte, sem codificar — a linha de base;
 *   produto   o codificador como o app usa (`preferirHardware: true`);
 *   cpu       o mesmo, com o `configure` forçado a `prefer-software`.
 *
 * Mede o tempo de CPU de cada processo do Chromium (`SystemInfo.getProcessInfo`
 * do CDP — funciona igual no Windows e no Linux) e o que o codificador diz de
 * si (`implementacao`, fps, ms por quadro). Núcleos = segundos de CPU por
 * segundo de parede, já descontada a cena `fonte`.
 *
 *   pnpm dev                                         (noutro terminal)
 *   node e2e/bench/codificador-gpu.bench.mjs         # Chromium do Playwright, headless (sem GPU)
 *
 * No Windows, com GPU de verdade (validação humana, D9 §6):
 *
 *   set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
 *   set HEADLESS=0
 *   node e2e/bench/codificador-gpu.bench.mjs --segundos=20
 *
 * `--json` imprime uma linha por cena.
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ?? chromium.executablePath();
const HEADLESS = process.env.HEADLESS !== '0';
const SEGUNDOS = Number(args['segundos'] ?? 15);
const AQUECIMENTO_MS = 3000;
const JSON_SAIDA = args['json'] === true;
const CENAS = String(args['cenas'] ?? 'fonte,produto,cpu').split(',');

const browser = await chromium.launch({ executablePath: CHROME, headless: HEADLESS });
const cdp = await browser.newBrowserCDPSession();

/** CPU acumulada por tipo de processo, em segundos. */
async function cpuPorTipo() {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const soma = {};
  for (const p of processInfo) {
    // renderer (WebCodecs em software e o nosso JS), GPU (Media Foundation), browser (captura); o resto junto.
    const tipo = ['renderer', 'GPU', 'browser'].includes(p.type) ? p.type : 'outros';
    soma[tipo] = (soma[tipo] ?? 0) + p.cpuTime;
  }
  return soma;
}

async function cena(nome) {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
  const pagina = await ctx.newPage();
  pagina.on('pageerror', (e) => console.log(`  [${nome}] pageerror: ${e.message}`));
  await pagina.goto(`${WEB}/@@e2e`, { waitUntil: 'networkidle' });
  await pagina.evaluate(
    async ({ nome }) => {
      // Fonte com cara de jogo: o quadro inteiro muda a cada vsync.
      const tela = document.createElement('canvas');
      tela.width = 1920;
      tela.height = 1080;
      tela.style.width = '160px';
      document.body.append(tela);
      const g = tela.getContext('2d');
      let f = 0;
      const desenhar = () => {
        f += 1;
        const grad = g.createLinearGradient(0, 0, 1920, 1080);
        grad.addColorStop(0, `hsl(${f % 360} 70% 40%)`);
        grad.addColorStop(1, `hsl(${(f * 3) % 360} 70% 20%)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, 1920, 1080);
        for (let i = 0; i < 300; i++) {
          g.fillStyle = `hsl(${(i * 7 + f) % 360} 80% 60%)`;
          g.fillRect((i * 97 + f * 5) % 1920, (i * 53 + f * 3) % 1080, 40, 40);
        }
        requestAnimationFrame(desenhar);
      };
      desenhar();
      const trilha = tela.captureStream(60).getVideoTracks()[0];
      window.__bench = { trilha, leituras: [] };
      if (nome === 'fonte') return;

      if (nome === 'cpu') {
        const Original = window.VideoEncoder;
        window.VideoEncoder = class extends Original {
          configure(c) {
            super.configure({ ...c, hardwareAcceleration: 'prefer-software' });
          }
        };
      }
      const { CodificadorWebCodecs } = await import('/src/adapters/webcodecs-codificador.ts');
      let bytes = 0;
      const cod = new CodificadorWebCodecs(
        (chunk) => {
          bytes += chunk.dados.byteLength;
        },
        () => performance.now(),
        () => undefined,
        { preferirHardware: true },
      );
      await cod.iniciar(trilha, { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000, limitadoPelaEstimativa: false });
      window.__bench.cod = cod;
      window.__bench.bytes = () => bytes;
      setInterval(() => {
        const s = cod.estatisticas();
        window.__bench.leituras.push({ fps: s.fps, ms: s.msPorQuadro, impl: s.implementacao, sobrecarga: s.sobrecarregado });
      }, 1000);
    },
    { nome },
  );
  await new Promise((r) => setTimeout(r, AQUECIMENTO_MS));
  await pagina.evaluate(() => {
    window.__bench.leituras.length = 0;
  });
  const antes = await cpuPorTipo();
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, SEGUNDOS * 1000));
  const depois = await cpuPorTipo();
  const parede = (Date.now() - t0) / 1000;
  const leituras = await pagina.evaluate(() => {
    window.__bench.cod?.parar();
    return window.__bench.leituras;
  });
  await ctx.close();

  const nucleos = {};
  for (const tipo of Object.keys(depois)) nucleos[tipo] = (depois[tipo] - (antes[tipo] ?? 0)) / parede;
  const comMs = leituras.filter((l) => l.ms !== null);
  return {
    cena: nome,
    nucleos,
    fps: leituras.length ? leituras.reduce((s, l) => s + l.fps, 0) / leituras.length : null,
    msPorQuadro: comMs.length ? comMs.reduce((s, l) => s + l.ms, 0) / comMs.length : null,
    implementacao: leituras.at(-1)?.impl ?? null,
    segundosSobrecarregado: leituras.filter((l) => l.sobrecarga).length,
  };
}

const resultados = [];
for (const nome of CENAS) resultados.push(await cena(nome));
await browser.close();

const base = resultados.find((r) => r.cena === 'fonte');
const tipos = [...new Set(resultados.flatMap((r) => Object.keys(r.nucleos)))].sort();
const fmt = (n, c = 2) => (n === null || n === undefined ? '—' : Number(n).toFixed(c).replace('.', ','));

if (JSON_SAIDA) {
  for (const r of resultados) console.log(JSON.stringify({ ...r, chrome: browser.version?.() ?? null }));
} else {
  console.log(`\nCodificador único — 1920×1080 a 60 fps, ${SEGUNDOS} s por cena · ${HEADLESS ? 'headless' : 'com janela'} · ${CHROME}`);
  console.log(`núcleos por processo (CPU s / s de parede)${base ? ', descontada a cena "fonte"' : ''}\n`);
  console.log(`  ${'cena'.padEnd(8)} ${tipos.map((t) => t.padStart(9)).join('')}    total   fps   ms/quadro  seg. sobrecarga  implementação`);
  for (const r of resultados) {
    const liq = (t) => (r.nucleos[t] ?? 0) - (r !== base && base ? (base.nucleos[t] ?? 0) : 0);
    const total = tipos.reduce((s, t) => s + liq(t), 0);
    console.log(
      `  ${(r === base ? 'fonte*' : r.cena).padEnd(8)} ${tipos.map((t) => fmt(liq(t)).padStart(9)).join('')}  ${fmt(total).padStart(7)}  ${fmt(r.fps, 0).padStart(4)}  ${fmt(r.msPorQuadro, 1).padStart(9)}  ${String(r.segundosSobrecarregado).padStart(15)}  ${r.implementacao ?? '—'}`,
    );
  }
  if (base) console.log('  * a fonte em valor absoluto (a linha de base das outras)');
  console.log('\nLeitura: "produto" com implementação WebCodecs·hardware e total bem abaixo de "cpu" = a GPU codifica.');
}
