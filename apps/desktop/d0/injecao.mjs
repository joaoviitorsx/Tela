/**
 * D0, caminho B — "um encode, N envios", validado contra o espectador web real.
 *
 * Um `VideoEncoder` (WebCodecs) codifica a fonte UMA vez; cada sender WebRTC
 * codifica só uma isca de 160x90 e um transform troca o conteúdo de cada quadro
 * pelo quadro real (ver injecao-worker.js). Os espectadores são a rota
 * `/<canal>` de verdade, sem saber de nada.
 *
 *   pnpm dev                                         (noutro terminal)
 *   pnpm --filter @tela/desktop exec electron d0/injecao.mjs
 *
 * TELA_D0_ESPECTADORES=1,3 · TELA_D0_SEGUNDOS=40 · TELA_D0_AQUECIMENTO=20 ·
 * TELA_D0_BITRATE=12000000
 */
import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const WEB = process.env.TELA_WEB ?? 'http://localhost:5173';
const SEGUNDOS = Number(process.env.TELA_D0_SEGUNDOS ?? 40);
const AQUECIMENTO = Number(process.env.TELA_D0_AQUECIMENTO ?? 20);
const BITRATE = Number(process.env.TELA_D0_BITRATE ?? 12_000_000);
const GRUPOS = (process.env.TELA_D0_ESPECTADORES ?? '1,3').split(',').map(Number);
const CODIGO_WORKER = readFileSync(join(AQUI, 'injecao-worker.js'), 'utf8');
/** `injecao` (um encode, N envios) ou `normal` (o caminho de hoje, para comparar). */
const MODO = process.env.TELA_D0_MODO ?? 'injecao';

const PREFERENCIAS = {
  backgroundThrottling: false,
  contextIsolation: true,
  sandbox: true,
  // `setMetadata` corrige largura/altura do quadro-isca; sem ele só a dica
  // de cabeçalho fica errada — o decoder lê o SPS.
  enableBlinkFeatures: 'RTCEncodedFrameSetMetadata',
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
/** `executeJavaScript` com prazo: página travada vira `{ travou }`, não espera eterna. */
const ler = (wc, codigo, rotulo) => Promise.race([
  wc.executeJavaScript(codigo),
  dormir(5000).then(() => ({ travou: rotulo })),
]);
const ticks = (pid) => {
  if (process.platform !== 'linux') return null;
  const c = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return Number(c[11]) + Number(c[12]);
};

async function montarHost({ slug, codigoWorker, bitrate, modo, contrapressao }) {
  const CONTRAPRESSAO = contrapressao;
  const W = 1920;
  const H = 1080;
  // Fonte com cara de jogo (mesma do d0/main.mjs).
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const mundo = document.createElement('canvas');
  mundo.width = 3600;
  mundo.height = 2400;
  const m = mundo.getContext('2d', { alpha: false });
  for (let i = 0; i < 4200; i += 1) {
    m.fillStyle = `hsl(${Math.random() * 360} ${40 + Math.random() * 55}% ${12 + Math.random() * 60}%)`;
    const s = 6 + Math.random() * 90;
    m.fillRect(Math.random() * 3600, Math.random() * 2400, s, s * (0.3 + Math.random()));
  }
  let t = 0;
  // Isca: 160x90, redesenhada no mesmo relógio — um quadro-isca por quadro real.
  const isca = document.createElement('canvas');
  isca.width = 160;
  isca.height = 90;
  const ictx = isca.getContext('2d', { alpha: false });
  setInterval(() => {
    t += 1 / 60;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(Math.sin(t * 0.7) * 0.25);
    ctx.drawImage(mundo, -1800 + Math.sin(t) * 700, -1200 + Math.cos(t * 0.8) * 500);
    ctx.restore();
    ictx.fillStyle = `hsl(${(t * 90) % 360} 50% 40%)`;
    ictx.fillRect(0, 0, 160, 90);
  }, 1000 / 60);
  const real = canvas.captureStream(60).getVideoTracks()[0];
  const trilhaIsca = isca.captureStream(60).getVideoTracks()[0];
  trilhaIsca.contentHint = 'motion';

  if (modo === 'normal') {
    const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
    const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
    const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
    const shared = await import('/node_modules/@tela/shared/dist/index.js');
    const transport = makeMeshTransport({
      channel: makeWsSignaling(`ws://${location.host}/signal`),
      scheduler: makeBrowserScheduler(),
    });
    await transport.host(slug, `d0${'n'.repeat(41)}`);
    real.contentHint = 'motion';
    await transport.publishVideo(real, shared.PRESETS.p1080p60);
    window.__d0Stats = async () => {
      const st = await transport.getAggregateStats();
      return {
        mbps: (st?.bitrateBps ?? 0) / 1e6, fps: st?.fps ?? 0, chaves: null,
        conectados: transport.peers().filter((p) => p.connectionState === 'connected').length,
        hardware: false, saida: `${st?.width}x${st?.height}`,
      };
    };
    return;
  }

  // Worker único para todos os senders.
  const worker = new Worker(URL.createObjectURL(new Blob([codigoWorker], { type: 'text/javascript' })));
  const canal = new MessageChannel();
  worker.postMessage({ tipo: 'porta', porta: canal.port2 }, [canal.port2]);

  // Todo sender de vídeo que nascer ganha o transform — o transporte não sabe.
  const anexar = (sender) => {
    if (sender && sender.transform == null) sender.transform = new RTCRtpScriptTransform(worker, {});
  };
  const addTrack = RTCPeerConnection.prototype.addTrack;
  RTCPeerConnection.prototype.addTrack = function (track, ...resto) {
    const s = addTrack.call(this, track, ...resto);
    if (track.kind === 'video') anexar(s);
    return s;
  };
  const addTransceiver = RTCPeerConnection.prototype.addTransceiver;
  RTCPeerConnection.prototype.addTransceiver = function (alvo, ...resto) {
    const tr = addTransceiver.call(this, alvo, ...resto);
    const tipo = typeof alvo === 'string' ? alvo : alvo.kind;
    if (tipo === 'video') anexar(tr.sender);
    return tr;
  };

  // O encoder único.
  let seq = 0;
  let pedirChave = true;
  let ultimaChave = 0;
  let bytes = 0;
  let chaves = 0;
  let quadrosCodificados = 0;
  const enc = new VideoEncoder({
    output: (chunk) => {
      const buf = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(buf);
      bytes += chunk.byteLength;
      quadrosCodificados += 1;
      if (chunk.type === 'key') chaves += 1;
      canal.port1.postMessage({ seq: seq++, key: chunk.type === 'key', data: buf, width: W, height: H }, [buf]);
    },
    error: (e) => console.error('[encoder]', e.message),
  });
  const config = {
    codec: 'avc1.42e02a', width: W, height: H, bitrate, framerate: 60,
    latencyMode: 'realtime', avc: { format: 'annexb' }, hardwareAcceleration: 'no-preference',
  };
  const suporte = await VideoEncoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-hardware' });
  enc.configure(config);
  let atraso = 0;
  let atrasoMax = 0;
  let pulados = 0;
  canal.port1.onmessage = (msg) => {
    // Muitos pedidos juntos (vários espectadores entrando) viram UM IDR.
    if (msg.data?.tipo === 'chave' && performance.now() - ultimaChave > 500) pedirChave = true;
    if (msg.data?.tipo === 'atraso') { atraso = msg.data.quadros; atrasoMax = Math.max(atrasoMax, atraso); }
  };
  const leitor = new MediaStreamTrackProcessor({ track: real }).readable.getReader();
  (async () => {
    for (;;) {
      const { value: f, done } = await leitor.read();
      if (done) return;
      if (enc.encodeQueueSize > 2) { f.close(); continue; } // encoder atrasado: descarta, não acumula
      // Contrapressão: há fila nos senders — este quadro não é codificado.
      if (CONTRAPRESSAO && atraso >= 2 && !pedirChave) { pulados += 1; f.close(); continue; }
      const chave = pedirChave;
      if (chave) { pedirChave = false; ultimaChave = performance.now(); }
      enc.encode(f, { keyFrame: chave });
      f.close();
    }
  })();

  const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
  const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
  const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
  const shared = await import('/node_modules/@tela/shared/dist/index.js');
  const transport = makeMeshTransport({
    channel: makeWsSignaling(`ws://${location.host}/signal`),
    scheduler: makeBrowserScheduler(),
  });
  console.log('d0: encoder ok, hardware=' + suporte.supported);
  await transport.host(slug, `d0${'i'.repeat(41)}`);
  console.log('d0: canal reivindicado');
  await transport.publishVideo(trilhaIsca, shared.PRESETS.p1080p60);
  console.log('d0: isca publicada');

  let marca = { t: performance.now(), bytes: 0, quadros: 0 };
  window.__d0Stats = () => {
    const agora = performance.now();
    const dt = (agora - marca.t) / 1000;
    const r = {
      mbps: ((bytes - marca.bytes) * 8) / 1e6 / dt,
      fps: (quadrosCodificados - marca.quadros) / dt,
      chaves,
      atraso,
      atrasoMax,
      pulados,
      conectados: transport.peers().filter((p) => p.connectionState === 'connected').length,
      hardware: suporte.supported,
    };
    marca = { t: agora, bytes, quadros: quadrosCodificados };
    return r;
  };
}

/** Roda na página do espectador: o que de fato chega e é DECODIFICADO (inbound-rtp). */
async function lerEspectador() {
  const v = document.querySelector('video');
  const r = { video: Boolean(v), w: v?.videoWidth ?? 0, h: v?.videoHeight ?? 0 };
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState !== 'connected') continue;
    const stats = await pc.getStats();
    stats.forEach((s) => {
      if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
      Object.assign(r, {
        decodificados: s.framesDecoded, descartados: s.framesDropped, recebidos: s.framesReceived,
        congelamentos: s.freezeCount, congeladoS: s.totalFreezesDuration, plis: s.pliCount,
        chaves: s.keyFramesDecoded, perdas: s.packetsLost, w: s.frameWidth ?? r.w, h: s.frameHeight ?? r.h,
        decoder: s.decoderImplementation,
      });
    });
  }
  return r;
}

async function rodar(n) {
  const host = new BrowserWindow({ show: true, width: 640, height: 360, title: `Tela D0 · injeção · ${n}`, webPreferences: PREFERENCIAS });
  host.webContents.on('console-message', (ev) => {
    const msg = ev.message ?? ev;
    if (!/OpenH264|vite/i.test(String(msg))) console.log(`  [host] ${msg}`);
  });
  await host.loadURL(`${WEB}/@@d0`);
  console.log('  host carregado');
  const slug = `inj${Math.random().toString(36).slice(2, 8)}`;
  await host.webContents.executeJavaScript(
    `(${montarHost.toString()})(${JSON.stringify({ slug, codigoWorker: CODIGO_WORKER, bitrate: BITRATE, modo: MODO, contrapressao: process.env.TELA_D0_CONTRAPRESSAO !== '0' })})`,
  );
  console.log('  host montado');
  const vs = [];
  for (let i = 0; i < n; i += 1) {
    const v = new BrowserWindow({
      show: false,
      webPreferences: {
        backgroundThrottling: false, sandbox: true, contextIsolation: false,
        preload: join(AQUI, 'espectador-preload.cjs'),
      },
    });
    v.webContents.setAudioMuted(true);
    v.webContents.on('console-message', (ev) => {
      const msg = String(ev.message ?? ev);
      if (/error|erro|fail/i.test(msg)) console.log(`  [espectador ${i}] ${msg.slice(0, 200)}`);
    });
    v.webContents.on('render-process-gone', (_e, d) => console.log(`  [espectador ${i}] renderer caiu: ${d.reason}`));
    v.loadURL(`${WEB}/${slug}`).catch((e) => console.log(`  [espectador ${i}] load: ${e.message}`));
    vs.push(v);
  }
  console.log(`  ${n} espectador(es) abertos`);
  await dormir(AQUECIMENTO * 1000);
  console.log('  aquecido');
  const pid = host.webContents.getOSProcessId();
  const antesV = await Promise.all(vs.map((v, i) => ler(v.webContents, `(${lerEspectador.toString()})()`, `espectador ${i}`)));
  console.log(`  espectadores antes: ${JSON.stringify(antesV)}`);
  console.log(`  host: ${JSON.stringify(await ler(host.webContents, 'window.__d0Stats()', 'host'))}`);
  const t0 = Date.now();
  const k0 = ticks(pid);
  const amostras = [];
  for (let s = 0; s < SEGUNDOS; s += 5) {
    await dormir(5000);
    amostras.push(await ler(host.webContents, 'window.__d0Stats()', 'host'));
    if (process.env.TELA_D0_SEGUIR === '1') {
      const v0 = await ler(vs[0].webContents, `(async () => {
        const pcs = window.__pcs ?? [];
        const ult = pcs.at(-1);
        let dec = null;
        if (ult) (await ult.getStats()).forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'video') dec = x.framesDecoded; });
        return { pcs: pcs.length, estados: pcs.map((p) => p.connectionState).join(','), dec,
                 tela: document.body.innerText.slice(0, 40).replace(/\\s+/g, ' ') };
      })()`, 'espectador 0');
      console.log(`  espectador 0: ${JSON.stringify(v0)}`);
    }
    console.log(`  amostra ${amostras.length}: ${JSON.stringify(amostras.at(-1))}`);
  }
  const nucleos = k0 === null ? null : (ticks(pid) - k0) / 100 / ((Date.now() - t0) / 1000);
  const depoisV = await Promise.all(vs.map((v, i) => ler(v.webContents, `(${lerEspectador.toString()})()`, `espectador ${i}`)));
  for (const v of vs) v.destroy();
  host.destroy();
  await dormir(3000);
  const media = (k) => amostras.reduce((a, x) => a + x[k], 0) / amostras.length;
  const segundos = (Date.now() - t0) / 1000;
  return {
    espectadores: n,
    hostNucleos: nucleos,
    encoderMbps: media('mbps'),
    encoderFps: media('fps'),
    idrs: amostras.at(-1)?.chaves,
    conectados: amostras.at(-1)?.conectados,
    hardware: amostras.at(-1)?.hardware,
    modo: MODO,
    saida: amostras.at(-1)?.saida,
    espectadoresRecebem: depoisV.map((d, i) => ({
      resolucao: `${d.w}x${d.h}`,
      fpsDecodificado: (d.decodificados - (antesV[i].decodificados ?? 0)) / segundos,
      fpsRecebido: (d.recebidos - (antesV[i].recebidos ?? 0)) / segundos,
      descartados: d.descartados - (antesV[i].descartados ?? 0),
      congelamentos: d.congelamentos - (antesV[i].congelamentos ?? 0),
      plis: d.plis - (antesV[i].plis ?? 0),
      perdas: d.perdas - (antesV[i].perdas ?? 0),
      decoder: d.decoder,
    })),
  };
}

app.whenReady().then(async () => {
  console.log(`\n=== D0 injeção · ${process.platform} · ${cpus()[0]?.model} · Chrome ${process.versions.chrome} ===`);
  for (const n of GRUPOS) {
    try {
      const r = await rodar(n);
      console.log(JSON.stringify(r));
    } catch (e) {
      console.log(`FALHOU com ${n} espectador(es): ${e?.message ?? e}`);
    }
  }
  app.quit();
});

// Fechar as janelas entre cenários não encerra a medição.
app.on('window-all-closed', () => undefined);
