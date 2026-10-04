/**
 * Encoder de hardware que só manda SPS/PPS no PRIMEIRO quadro-chave: quem entra
 * ou reconecta depois tem de decodificar mesmo assim (relato de 04/10 — som
 * tocando, tela preta). O `VideoEncoder` do Chromium headless é software e
 * repete SPS em todo IDR, então aqui a gente IMITA o hardware: embrulha o
 * `VideoEncoder` e tira SPS (NAL 7) e PPS (NAL 8) de todo quadro-chave que não
 * seja o primeiro depois de um `configure` que mudou o tamanho.
 *
 * Sem a correção (`ParametrosH264`), o espectador tardio fica em 0 fps e pede
 * quadro-chave sem parar. Com ela, decodifica.
 *
 *   pnpm dev                 (noutro terminal)
 *   node e2e/sps-hardware.e2e.mjs
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

/** Imita hardware: SPS/PPS só no 1º quadro-chave depois de cada mudança de tamanho. */
const imitarHardware = () => {
  const Orig = window.VideoEncoder;
  window.__semSps = 0;
  window.VideoEncoder = class extends Orig {
    constructor(init) {
      let primeiro = true;
      super({
        ...init,
        output: (chunk, meta) => {
          if (chunk.type !== 'key' || primeiro) {
            if (chunk.type === 'key') primeiro = false;
            return init.output(chunk, meta);
          }
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          const ini = [];
          for (let i = 0; i + 3 < b.length; i += 1) {
            if (b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || (b[i + 2] === 0 && b[i + 3] === 1))) {
              ini.push(i);
              i += 2;
            }
          }
          const partes = [];
          ini.forEach((s, k) => {
            const fim = ini[k + 1] ?? b.length;
            const off = b[s + 2] === 1 ? 3 : 4;
            const tipo = b[s + off] & 0x1f;
            if (tipo !== 7 && tipo !== 8) partes.push(b.subarray(s, fim));
          });
          const out = new Uint8Array(partes.reduce((a, x) => a + x.length, 0));
          let o = 0;
          for (const x of partes) {
            out.set(x, o);
            o += x.length;
          }
          window.__semSps += 1;
          init.output(new EncodedVideoChunk({ type: 'key', timestamp: chunk.timestamp, duration: chunk.duration ?? undefined, data: out }), meta);
        },
      });
      const configure = this.configure.bind(this);
      let tam = '';
      this.configure = (c) => {
        const t = `${c.width}x${c.height}`;
        if (t !== tam) {
          tam = t;
          primeiro = true;
        }
        return configure(c);
      };
    }
  };
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function pagina(rotulo, hardware = false) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(guardarPcs);
  if (hardware) await ctx.addInitScript(imitarHardware);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${rotulo}] pageerror: ${e.message}`));
  return p;
}

const slug = `sps${Math.random().toString(36).slice(2, 8)}`;
const host = await pagina('host', true);
await host.goto(`${WEB}/@@e2e`, { waitUntil: 'networkidle' });

console.log('\n1. Transmissor com encoder que imita hardware (SPS só no 1º IDR)');
const subiu = await host.evaluate(async ([canal]) => {
  const W = 1280;
  const H = 720;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const mundo = document.createElement('canvas');
  mundo.width = 2400;
  mundo.height = 1600;
  const m = mundo.getContext('2d', { alpha: false });
  for (let i = 0; i < 2500; i += 1) {
    m.fillStyle = `hsl(${Math.random() * 360} 60% ${15 + Math.random() * 55}%)`;
    const s = 6 + Math.random() * 70;
    m.fillRect(Math.random() * 2400, Math.random() * 1600, s, s);
  }
  let t = 0;
  setInterval(() => {
    t += 1 / 30;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(Math.sin(t * 0.7) * 0.2);
    ctx.drawImage(mundo, -1200 + Math.sin(t) * 400, -800 + Math.cos(t * 0.8) * 300);
    ctx.restore();
  }, 1000 / 30);
  const video = canvas.captureStream(30).getVideoTracks()[0];
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
    screen: { isSupported: () => true, request: async () => ({ ok: true, value: { video, audio: null, surface: 'monitor' } }) },
    audio: { requestPermission: async () => false, listMonitors: async () => [], capture: async () => { throw new Error('sem áudio'); } },
    gain: makeBrowserAudioGain(),
    scheduler,
    shareUrlFor: (x) => `${location.origin}/${x}`,
    createStream: (tracks) => new MediaStream([...tracks]),
  });
  window.__sessao = session;
  await session.start(canal, `e2e${'u'.repeat(40)}`, { presetId: 'p720p60' });
  return session.getState().status;
}, [slug]);
ok(subiu === 'live', `sessão no ar (${subiu})`);

const lerEspectador = (p) => p.evaluate(async () => {
  const r = { pcs: (window.__pcs ?? []).length };
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState !== 'connected') continue;
    (await pc.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') Object.assign(r, { w: s.frameWidth, dec: s.framesDecoded, plis: s.pliCount });
    });
  }
  return r;
});
const medir = async (p, seg, rot) => {
  const a = await lerEspectador(p);
  await esperar(seg * 1000);
  const d = await lerEspectador(p);
  const fps = ((d.dec ?? 0) - (a.dec ?? 0)) / seg;
  console.log(`   ${rot}: ${d.w ?? 0}px · ${fps.toFixed(1)} fps · pli ${d.plis ?? 0} · pcs ${d.pcs}`);
  return fps;
};

console.log('\n2. Espectador que entra DEPOIS do primeiro quadro-chave');
await esperar(12_000); // o 1º IDR (com SPS) já passou; o hardware já está omitindo
const tarde = await pagina('tarde');
await tarde.goto(`${WEB}/${slug}`, { waitUntil: 'domcontentloaded' });
await esperar(8_000);
const fpsTarde = await medir(tarde, 8, 'entrou tarde');
ok(fpsTarde >= 10, `espectador tardio decodifica apesar do hardware sem SPS (${fpsTarde.toFixed(1)} fps)`);

console.log('\n3. Reconexão: a conexão morre e o Tela refaz');
await tarde.evaluate(() => { for (const pc of window.__pcs) pc.close(); });
await esperar(18_000);
const fpsRecon = await medir(tarde, 8, 'reconectou');
ok(fpsRecon >= 10, `espectador decodifica depois de reconectar (${fpsRecon.toFixed(1)} fps)`);

const semSps = await host.evaluate(() => window.__semSps ?? 0);
ok(semSps > 0, `o teste de fato imitou hardware sem SPS (${semSps} quadros-chave sem SPS)`);

await browser.close();
console.log(process.exitCode ? '\n=== SPS-HARDWARE FALHOU ===' : '\n=== SPS-HARDWARE PASSOU ===');
