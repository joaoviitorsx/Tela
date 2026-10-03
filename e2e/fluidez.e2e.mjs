/**
 * Bancada de FLUIDEZ: o que o espectador sente, não o que o transmissor diz.
 *
 * Mede, no `inbound-rtp` de cada espectador (rota de produção `/<canal>`):
 *  - fps decodificado;
 *  - o RITMO: média e desvio do intervalo entre quadros
 *    (`totalInterFrameDelay` / `totalSquaredInterFrameDelay`) — fps "certo"
 *    com quadros chegando aos trancos é o que se vê como engasgo;
 *  - congelamentos e o buffer de reprodução (`jitterBufferDelay`).
 *
 * Compara o transporte de produção ("um encode, N envios", com isca e
 * injeção) com o mesh simples (cada sender codifica), mesma fonte animada.
 *
 *   pnpm dev                                   (noutro terminal)
 *   MODO=umencode node e2e/fluidez.e2e.mjs      (padrão)
 *   MODO=mesh     node e2e/fluidez.e2e.mjs
 *   FPS=60 W=1280 H=720 ESPECTADORES=2 SEGUNDOS=30
 */
import { chromium } from 'playwright';

const CHROME = process.env.CHROME ?? chromium.executablePath();
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const MODO = process.env.MODO ?? 'umencode';
const FPS = Number(process.env.FPS ?? 60);
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 720);
const ESPECTADORES = Number(process.env.ESPECTADORES ?? 2);
const SEGUNDOS = Number(process.env.SEGUNDOS ?? 30);
const PRESET = process.env.PRESET ?? 'p720p60';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  // Sem isto o headless estrangula timers de páginas "em segundo plano" e a fonte perde o ritmo.
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

const guardarPcs = () => {
  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = class extends Original {
    constructor(...a) {
      super(...a);
      window.__pcs.push(this);
    }
  };
};

async function pagina() {
  const ctx = await browser.newContext();
  await ctx.addInitScript(guardarPcs);
  return ctx.newPage();
}

const slug = `flu${Math.random().toString(36).slice(2, 8)}`;
const host = await pagina();
await host.goto(`${WEB}/@@e2e`, { waitUntil: 'networkidle' });

const subiu = await host.evaluate(async ([canal, modo, fps, w, h, preset]) => {
  // Fonte com cara de jogo, desenhada no ritmo de requestAnimationFrame-like
  // por setInterval — cada quadro muda (mundo rolando), para o capturador
  // nunca ter motivo de pular quadro.
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  const mundo = document.createElement('canvas');
  mundo.width = w * 2;
  mundo.height = h * 2;
  const m = mundo.getContext('2d', { alpha: false });
  for (let i = 0; i < 2500; i += 1) {
    m.fillStyle = `hsl(${Math.random() * 360} 60% ${15 + Math.random() * 55}%)`;
    const s = 6 + Math.random() * 70;
    m.fillRect(Math.random() * w * 2, Math.random() * h * 2, s, s);
  }
  let t = 0;
  window.__desenhados = 0;
  setInterval(() => {
    t += 1 / fps;
    ctx.drawImage(mundo, -w / 2 + Math.sin(t) * (w / 3), -h / 2 + Math.cos(t * 0.8) * (h / 4));
    window.__desenhados += 1;
  }, 1000 / fps);
  const video = canvas.captureStream(fps).getVideoTracks()[0];

  const { BroadcastSession } = await import('/src/core/media/broadcast-session.ts');
  const { makeEncodeOnceTransport } = await import('/src/adapters/encode-once-transport.ts');
  const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
  const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
  const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
  const { makeBrowserAudioGain } = await import('/src/adapters/browser-audio-gain.ts');
  const scheduler = makeBrowserScheduler();
  const channel = makeWsSignaling(`ws://${location.host}/signal`);
  const transport = modo === 'mesh'
    ? makeMeshTransport({ channel, scheduler })
    : makeEncodeOnceTransport({
        channel,
        scheduler,
        criarWorker: () => new Worker(new URL('/src/adapters/injecao-worker.ts', location.origin), { type: 'module' }),
      });
  const session = new BroadcastSession({
    transport,
    screen: { isSupported: () => true, request: async () => ({ ok: true, value: { video, audio: null, surface: 'monitor' } }) },
    audio: { requestPermission: async () => false, listMonitors: async () => [], capture: async () => { throw new Error('sem áudio'); } },
    gain: makeBrowserAudioGain(),
    scheduler,
    shareUrlFor: (x) => `${location.origin}/${x}`,
    createStream: (tracks) => new MediaStream([...tracks]),
  });
  window.__sessao = session;
  await session.start(canal, `e2e${'f'.repeat(40)}`, { presetId: preset });
  return session.getState().status;
}, [slug, MODO, FPS, W, H, PRESET]);
if (subiu !== 'live') {
  console.error(`sessão não subiu (${subiu})`);
  process.exit(1);
}

const espectadores = [];
for (let i = 0; i < ESPECTADORES; i += 1) {
  const v = await pagina();
  await v.goto(`${WEB}/${slug}`, { waitUntil: 'domcontentloaded' });
  espectadores.push(v);
}

const ler = (p) => p.evaluate(async () => {
  const r = {};
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState !== 'connected') continue;
    (await pc.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        Object.assign(r, {
          dec: s.framesDecoded ?? 0,
          drop: s.framesDropped ?? 0,
          ifd: s.totalInterFrameDelay ?? 0,
          ifd2: s.totalSquaredInterFrameDelay ?? 0,
          cong: s.freezeCount ?? 0,
          congS: s.totalFreezesDuration ?? 0,
          jb: s.jitterBufferDelay ?? 0,
          jbN: s.jitterBufferEmittedCount ?? 0,
          w: s.frameWidth,
          h: s.frameHeight,
        });
      }
    });
  }
  return r;
});

// Uma linha por segundo do que o TRANSMISSOR mede (encoder e escada).
const amostrasDoHost = [];
const coletor = setInterval(() => {
  void host.evaluate(async () => {
    // O que a própria sessão leu por último — chamar getAggregateStats daqui zeraria os contadores dela.
    const s = window.__sessao.getState();
    const st = s.stats;
    return { degrau: s.presetId, lim: st?.limitation, fps: st?.fps && Math.round(st.fps), mspq: st?.msPorQuadro && +st.msPorQuadro.toFixed(1), cap: st?.fpsDaCaptura && Math.round(st.fpsDaCaptura), seg: st?.fila?.seguradosPorSegundo };
  }).then((x) => amostrasDoHost.push(x), () => undefined);
}, 1000);
await esperar(15_000);
const antes = await Promise.all(espectadores.map(ler));
const hostAntes = await host.evaluate(() => window.__desenhados);
await esperar(SEGUNDOS * 1000);
const depois = await Promise.all(espectadores.map(ler));
const hostDepois = await host.evaluate(() => window.__desenhados);
const estado = await host.evaluate(() => {
  const s = window.__sessao.getState();
  return s.status === 'live' ? { degrau: s.presetId, enc: s.stats?.encoderImplementation, fps: s.stats?.fps } : { status: s.status };
});

console.log(`\nMODO=${MODO} fonte ${W}x${H}@${FPS} (${((hostDepois - hostAntes) / SEGUNDOS).toFixed(1)} desenhados/s) · ${JSON.stringify(estado)}`);
const linhas = depois.map((d, i) => {
  const a = antes[i];
  const n = d.dec - a.dec;
  const media = n > 0 ? (d.ifd - a.ifd) / n : 0;
  const var_ = n > 0 ? (d.ifd2 - a.ifd2) / n - media * media : 0;
  return {
    espectador: i,
    resolucao: `${d.w}x${d.h}`,
    fps: +(n / SEGUNDOS).toFixed(1),
    intervaloMs: +(media * 1000).toFixed(1),
    desvioMs: +(Math.sqrt(Math.max(0, var_)) * 1000).toFixed(1),
    descartados: d.drop - a.drop,
    congelamentos: d.cong - a.cong,
    congeladoS: +(d.congS - a.congS).toFixed(2),
    bufferMs: d.jbN - a.jbN > 0 ? +(((d.jb - a.jb) / (d.jbN - a.jbN)) * 1000).toFixed(0) : null,
  };
});
clearInterval(coletor);
console.table(linhas);
if (process.env.HOST === '1') for (const a of amostrasDoHost) console.log(JSON.stringify(a));
console.log(JSON.stringify({ modo: MODO, fps: FPS, w: W, h: H, linhas }));
await browser.close();
