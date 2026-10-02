/**
 * Captura parada (Alt+Tab num jogo em tela cheia, tela estática) em Chrome real.
 *
 * Relato de 02/10: "dá Alt+Tab e volta e a tela fica travada"; o diagnóstico
 * do espectador mostrava 0 kbps com a ligação viva. No "um encode" a isca só
 * gera vaga a cada quadro capturado: captura parada = nada sai, nem o
 * quadro-chave de quem entra.
 *
 * Critérios, com a fonte do anfitrião parada por 6 s:
 *   1. quem já assistia continua recebendo vídeo (bytes chegando);
 *   2. quem entra no meio da pausa vê imagem (quadro decodificado);
 *   3. quando a fonte volta, os dois seguem decodificando.
 *
 *   pnpm dev                       (noutro terminal)
 *   node e2e/captura-parada.e2e.mjs
 */
import { chromium } from 'playwright';

const CHROME = process.env.CHROME ?? chromium.executablePath();
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
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

const slug = `cp${Math.random().toString(36).slice(2, 8)}`;
const host = await pagina();
await host.goto(`${WEB}/@@e2e`, { waitUntil: 'networkidle' });

console.log('\n1. Anfitrião no ar com uma fonte que dá para pausar');
await host.evaluate(async (canal) => {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const x = c.getContext('2d', { alpha: false });
  const g = new MediaStreamTrackGenerator({ kind: 'video' });
  const w = g.writable.getWriter();
  let t = 0;
  window.__fontePausada = false;
  setInterval(() => {
    if (window.__fontePausada) return;
    t += 1;
    x.fillStyle = `hsl(${(t * 3) % 360} 50% 40%)`;
    x.fillRect(0, 0, 1280, 720);
    x.fillStyle = '#fff';
    x.fillRect((t * 9) % 1280, 300, 120, 120);
    const vf = new VideoFrame(c, { timestamp: Math.round(performance.now() * 1000) });
    w.write(vf).catch(() => vf.close());
  }, 1000 / 30);
  const { BroadcastSession } = await import('/src/core/media/broadcast-session.ts');
  const { makeEncodeOnceTransport } = await import('/src/adapters/encode-once-transport.ts');
  const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
  const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
  const { makeBrowserAudioGain } = await import('/src/adapters/browser-audio-gain.ts');
  const scheduler = makeBrowserScheduler();
  const s = new BroadcastSession({
    transport: makeEncodeOnceTransport({
      channel: makeWsSignaling(`ws://${location.host}/signal`),
      scheduler,
      criarWorker: () => new Worker(new URL('/src/adapters/injecao-worker.ts', location.origin), { type: 'module' }),
    }),
    capacidade: 50,
    screen: { isSupported: () => true, request: async () => ({ ok: true, value: { video: g, audio: null, surface: 'monitor' } }) },
    audio: { requestPermission: async () => false, listMonitors: async () => [], capture: async () => { throw new Error('x'); } },
    gain: makeBrowserAudioGain(),
    scheduler,
    shareUrlFor: (y) => y,
    createStream: (tr) => new MediaStream([...tr]),
  });
  await s.start(canal, `e2e${'p'.repeat(40)}`, { presetId: 'p720p60' });
}, slug);

const ler = (p) =>
  p.evaluate(async () => {
    const r = { bytes: 0, dec: 0 };
    for (const pc of window.__pcs ?? []) {
      (await pc.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          r.bytes += s.bytesReceived ?? 0;
          r.dec += s.framesDecoded ?? 0;
        }
      });
    }
    return r;
  });

const a = await pagina();
await a.goto(`${WEB}/${slug}`);
await esperar(12_000);
const a0 = await ler(a);
ok(a0.dec > 0, `espectador A assistindo antes da pausa (${a0.dec} quadros)`);

console.log('\n2. A fonte para (Alt+Tab) e B entra no meio da pausa');
await host.evaluate(() => {
  window.__fontePausada = true;
});
await esperar(1500);
const aAntes = await ler(a);
const b = await pagina();
await b.goto(`${WEB}/${slug}`);
await esperar(4500);
const aDepois = await ler(a);
const bPausa = await ler(b);
console.log(`   A: ${aDepois.bytes - aAntes.bytes} bytes em 4,5 s de pausa · B: ${bPausa.dec} quadro(s)`);
ok(aDepois.bytes - aAntes.bytes > 2_000, 'A continua recebendo vídeo com a fonte parada');
ok(bPausa.dec > 0, 'B, que entrou na pausa, vê imagem');

console.log('\n3. A fonte volta');
await host.evaluate(() => {
  window.__fontePausada = false;
});
const aVolta = await ler(a);
const bVolta = await ler(b);
await esperar(4000);
const aFim = await ler(a);
const bFim = await ler(b);
ok(aFim.dec - aVolta.dec > 60, `A decodifica de novo (${aFim.dec - aVolta.dec} quadros em 4 s)`);
ok(bFim.dec - bVolta.dec > 60, `B decodifica de novo (${bFim.dec - bVolta.dec} quadros em 4 s)`);

await browser.close();
console.log(process.exitCode ? '\n=== CAPTURA PARADA FALHOU ===' : '\n=== CAPTURA PARADA PASSOU ===');
