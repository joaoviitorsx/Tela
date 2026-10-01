/**
 * D0 — custo PURO do encoder H.264 que o Chromium usa nesta máquina, sem rede.
 *
 * O WebRTC no loopback não deixa medir 1080p: a estimativa de banda trava em
 * ~16 Mbps e o próprio Chromium reduz a resolução. Aqui o WebCodecs codifica
 * quadros de uma fonte com cara de jogo, em tempo real, no mesmo encoder
 * (`hardwareAcceleration: 'no-preference'` — o Chromium escolhe, como no
 * WebRTC), e a CPU do renderer é lida pelo /proc.
 *
 *   pnpm --filter @tela/desktop exec electron d0/encoder.mjs
 */
import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

const SEGUNDOS = Number(process.env.TELA_D0_SEGUNDOS ?? 20);
/**
 * CPU acumulada do renderer, em núcleo·segundos. Linux: /proc. Windows e
 * outros: integra o `percentCPUUsage` do Electron (% da MÁQUINA, conferido
 * contra o /proc no Linux) amostrado a cada 500 ms.
 */
let acumulado = 0;
let ultimoPid = null;
const NUCLEOS = cpus().length;
setInterval(() => {
  if (ultimoPid === null || process.platform === 'linux') return;
  const m = app.getAppMetrics().find((x) => x.pid === ultimoPid);
  if (m) acumulado += (m.cpu.percentCPUUsage / 100) * NUCLEOS * 0.5;
}, 500);
const ticks = (pid) => {
  ultimoPid = pid;
  if (process.platform !== 'linux') return acumulado * 100;
  const c = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return Number(c[11]) + Number(c[12]);
};

async function codificar({ w, h, fps, bps }) {
  const t0 = performance.now();
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  const mundo = new OffscreenCanvas(3600, 2400);
  const m = mundo.getContext('2d', { alpha: false });
  for (let i = 0; i < 4200; i += 1) {
    m.fillStyle = `hsl(${Math.random() * 360} 70% ${15 + Math.random() * 55}%)`;
    const s = 6 + Math.random() * 90;
    m.fillRect(Math.random() * 3600, Math.random() * 2400, s, s);
  }
  let saida = 0;
  let hw = null;
  const enc = new VideoEncoder({
    output: (chunk) => { saida += chunk.byteLength; },
    error: (e) => { hw = `erro: ${e.message}`; },
  });
  const cfg = { codec: 'avc1.640028', width: w, height: h, bitrate: bps, framerate: fps, latencyMode: 'realtime', avc: { format: 'annexb' } };
  const suporte = await VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: 'prefer-hardware' });
  hw = suporte.supported ? 'hardware-disponivel' : 'hardware-indisponivel';
  enc.configure(cfg);
  let n = 0;
  await new Promise((fim) => {
    const id = setInterval(() => {
      const t = n / fps;
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(Math.sin(t * 0.7) * 0.25);
      ctx.drawImage(mundo, -1800 + Math.sin(t) * 700, -1200 + Math.cos(t * 0.8) * 500);
      ctx.restore();
      const f = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6) });
      enc.encode(f, { keyFrame: n % (fps * 4) === 0 });
      f.close();
      n += 1;
      if (performance.now() - t0 > __SEG__ * 1000) { clearInterval(id); fim(); }
    }, 1000 / fps);
  });
  await enc.flush();
  return { quadros: n, mbps: (saida * 8) / 1e6 / __SEG__, hw, filaFinal: enc.encodeQueueSize };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } });
  // WebCodecs exige contexto seguro: `data:` não é, `localhost` é.
  await win.loadURL(`${process.env.TELA_WEB ?? 'http://localhost:5173'}/@@d0`);
  const pid = win.webContents.getOSProcessId();
  const cenarios = [
    { nome: 'fonte-so-desenho', w: 1920, h: 1080, fps: 60, bps: 0 },
    { nome: '720p60 @ 8 Mbps', w: 1280, h: 720, fps: 60, bps: 8_000_000 },
    { nome: '1080p60 @ 12 Mbps', w: 1920, h: 1080, fps: 60, bps: 12_000_000 },
    { nome: '1080p60 @ 20 Mbps', w: 1920, h: 1080, fps: 60, bps: 20_000_000 },
  ];
  console.log(`\n=== D0 encoder puro · ${process.platform} · Chrome ${process.versions.chrome} ===`);
  for (const c of cenarios) {
    const codigo = codificar.toString().replaceAll('__SEG__', String(SEGUNDOS));
    const corpo = c.bps === 0
      ? `(async () => { const cv = new OffscreenCanvas(${c.w}, ${c.h}); const x = cv.getContext('2d'); let n=0; await new Promise((r) => { const id = setInterval(() => { x.fillStyle = 'hsl(' + (n++ % 360) + ' 70% 40%)'; x.fillRect(0,0,${c.w},${c.h}); }, 16); setTimeout(() => { clearInterval(id); r(); }, ${SEGUNDOS * 1000}); }); return { quadros: n }; })()`
      : `(${codigo})(${JSON.stringify(c)})`;
    const a = ticks(pid);
    const t = Date.now();
    const r = await win.webContents.executeJavaScript(corpo).catch((e) => ({ erro: String(e) }));
    const nucleos = (ticks(pid) - a) / 100 / ((Date.now() - t) / 1000);
    console.log(`${c.nome.padEnd(20)} ${nucleos.toFixed(2)} núcleo(s) · ${JSON.stringify(r)}`);
  }
  app.quit();
});
