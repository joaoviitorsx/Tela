/**
 * A3/B2 de docs/engenharia/complexidade.md: quanto o CHROMIUM de quem
 * transmite gasta por espectador — pacotizar, cifrar e enviar a mesma mídia N
 * vezes, e o `getStats` de N conexões. Não cabe em bancada Node; aqui é o
 * navegador de verdade, headless, sem janela.
 *
 * O host roda num Chromium PRÓPRIO (processo separado dos espectadores), com
 * `BroadcastSession` + "um encode" e uma fonte 1280x720@60 desenhada em canvas.
 * A CPU é a soma da árvore de processos dele (/proc, Linux). O custo marginal
 * por espectador é a inclinação entre os tamanhos de sala — o desenho da
 * fonte e o encode único são constantes e somem na diferença.
 *
 *   pnpm dev                                        (noutro terminal)
 *   node e2e/bench/chromium-por-espectador.mjs      SALAS=1,5,10,20 SEGUNDOS=20
 */
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const SALAS = (process.env.SALAS ?? '1,5,10,20').split(',').map(Number);
const SEGUNDOS = Number(process.env.SEGUNDOS ?? 20);
const AQUECIMENTO = Number(process.env.AQUECIMENTO ?? 12);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ticks de CPU (user+sys) de um processo e de todos os descendentes. */
function ticksDaArvore(raiz) {
  const filhos = new Map();
  for (const nome of readdirSync('/proc')) {
    if (!/^\d+$/.test(nome)) continue;
    try {
      const c = readFileSync(`/proc/${nome}/stat`, 'utf8').split(') ')[1].split(' ');
      const pai = Number(c[1]);
      if (!filhos.has(pai)) filhos.set(pai, []);
      filhos.get(pai).push({ pid: Number(nome), ticks: Number(c[11]) + Number(c[12]) });
    } catch {
      // processo sumiu no meio da leitura
    }
  }
  let total = 0;
  const pilha = [raiz];
  const proprio = readFileSync(`/proc/${raiz}/stat`, 'utf8').split(') ')[1].split(' ');
  total += Number(proprio[11]) + Number(proprio[12]);
  while (pilha.length > 0) {
    for (const f of filhos.get(pilha.pop()) ?? []) {
      total += f.ticks;
      pilha.push(f.pid);
    }
  }
  return total;
}

async function medirSala(n) {
  // `launchServer` expõe o processo do navegador; `launch` não.
  const hostServer = await chromium.launchServer({ headless: true });
  const hostBrowser = await chromium.connect(hostServer.wsEndpoint());
  const espectadores = await chromium.launch({ headless: true });
  try {
    const host = await (await hostBrowser.newContext()).newPage();
    await host.goto(`${WEB}/@@bench`, { waitUntil: 'networkidle' });
    const slug = `bn${Math.random().toString(36).slice(2, 8)}`;
    const subiu = await host.evaluate(async (canal) => {
      const W = 1280;
      const H = 720;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { alpha: false });
      let t = 0;
      setInterval(() => {
        t += 1;
        ctx.fillStyle = `hsl(${t % 360} 70% 40%)`;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff';
        ctx.fillRect((t * 9) % W, (t * 5) % H, 120, 120);
      }, 1000 / 60);
      const video = canvas.captureStream(60).getVideoTracks()[0];
      const { BroadcastSession } = await import('/src/core/media/broadcast-session.ts');
      const { makeEncodeOnceTransport } = await import('/src/adapters/encode-once-transport.ts');
      const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
      const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
      const { makeBrowserAudioGain } = await import('/src/adapters/browser-audio-gain.ts');
      const scheduler = makeBrowserScheduler();
      const session = new BroadcastSession({
        transport: makeEncodeOnceTransport({
          channel: makeWsSignaling(`ws://${location.host}/signal`),
          scheduler,
          criarWorker: () => new Worker(new URL('/src/adapters/injecao-worker.ts', location.origin), { type: 'module' }),
        }),
        capacidade: 50,
        screen: { isSupported: () => true, request: async () => ({ ok: true, value: { video, audio: null, surface: 'monitor' } }) },
        audio: { requestPermission: async () => false, listMonitors: async () => [], capture: async () => { throw new Error('sem áudio'); } },
        gain: makeBrowserAudioGain(),
        scheduler,
        shareUrlFor: (x) => `${location.origin}/${x}`,
        createStream: (tracks) => new MediaStream([...tracks]),
      });
      window.__sessao = session;
      await session.start(canal, `bn${'b'.repeat(41)}`, { presetId: 'p720p60' });
      return session.getState().status;
    }, slug);
    if (subiu !== 'live') throw new Error(`host não subiu: ${subiu}`);

    const ctx = await espectadores.newContext();
    for (let i = 0; i < n; i += 1) {
      const p = await ctx.newPage();
      await p.goto(`${WEB}/${slug}`, { waitUntil: 'domcontentloaded' });
    }
    await esperar(AQUECIMENTO * 1000);
    const pid = hostServer.process()?.pid;
    if (pid === undefined) throw new Error('sem pid do host');
    const t0 = ticksDaArvore(pid);
    const inicio = Date.now();
    await esperar(SEGUNDOS * 1000);
    const nucleos = (ticksDaArvore(pid) - t0) / 100 / ((Date.now() - inicio) / 1000);
    const estado = await host.evaluate(() => {
      const s = window.__sessao.getState();
      return s.status === 'live'
        ? { conectados: s.peers.filter((p) => p.connectionState === 'connected').length, saida: `${s.stats?.width}x${s.stats?.height}@${Math.round(s.stats?.fps ?? 0)}`, degrau: s.presetId }
        : { status: s.status };
    });
    return { n, nucleos, ...estado };
  } finally {
    await espectadores.close();
    await hostBrowser.close();
    await hostServer.close();
  }
}

console.log(`\nChromium de quem transmite, por tamanho de sala (${SEGUNDOS}s cada, aquecimento ${AQUECIMENTO}s)\n`);
const linhas = [];
for (const n of SALAS) {
  const r = await medirSala(n);
  linhas.push(r);
  console.log(`  N=${String(n).padStart(2)}  ${r.nucleos.toFixed(3)} núcleo  conectados ${r.conectados}  saída ${r.saida}  ${r.degrau}`);
}
if (linhas.length >= 2) {
  // Mínimos quadrados: núcleos = a + b·N. b é o custo marginal por espectador.
  const xs = linhas.map((l) => l.n);
  const ys = linhas.map((l) => l.nucleos);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const a = my - b * mx;
  console.log(`\n  ajuste: ${a.toFixed(3)} + ${b.toFixed(4)}·N núcleo  →  a N=50: ${(a + b * 50).toFixed(2)} núcleo`);
}
