/**
 * D0, caminho B — "um encode, N envios", validado contra o espectador web real.
 *
 * Um `VideoEncoder` (WebCodecs) codifica a fonte UMA vez; cada sender WebRTC
 * codifica só uma isca de 160x90 e um transform troca o conteúdo de cada quadro
 * pelo quadro real (ver apps/web/src/adapters/injecao-worker.ts). Os espectadores são a rota
 * `/<canal>` de verdade, sem saber de nada.
 *
 *   pnpm dev                                         (noutro terminal)
 *   pnpm --filter @tela/desktop exec electron d0/injecao.mjs
 *
 * TELA_D0_ESPECTADORES=1,3 · TELA_D0_SEGUNDOS=40 · TELA_D0_AQUECIMENTO=20 ·
 * TELA_D0_MODO=produto|normal
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
const GRUPOS = (process.env.TELA_D0_ESPECTADORES ?? '1,3').split(',').map(Number);
/** `produto` (um encode, N envios, como o app usa) ou `normal` (o caminho de hoje, para comparar). */
const MODO = process.env.TELA_D0_MODO ?? 'produto';

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

async function montarHost({ slug, modo }) {
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

  if (modo === 'produto') {
    // O produto: BroadcastSession real (malhas, governador) sobre o transporte
    // "um encode, N envios" — o mesmo que o app vai usar.
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
      screen: { isSupported: () => true, request: async () => ({ ok: true, value: { video: real, audio: null, surface: 'monitor' } }) },
      audio: { requestPermission: async () => false, listMonitors: async () => [], capture: async () => { throw new Error('sem áudio'); } },
      gain: makeBrowserAudioGain(),
      scheduler,
      shareUrlFor: (x) => `${location.origin}/${x}`,
      createStream: (tracks) => new MediaStream([...tracks]),
    });
    await session.start(slug, `d0${'p'.repeat(41)}`, { presetId: 'p1080p60' });
    window.__d0Stats = () => {
      const st = session.getState();
      const x = st.status === 'live' ? st.stats : null;
      return {
        mbps: (x?.bitrateBps ?? 0) / 1e6, fps: x?.fps ?? 0, chaves: null,
        conectados: st.status === 'live' ? st.peers.filter((p) => p.connectionState === 'connected').length : 0,
        hardware: x?.encoderImplementation ?? null, saida: `${x?.width}x${x?.height}`,
        degrau: st.status === 'live' ? st.presetId : st.status, limitacao: x?.limitation ?? null,
        bpp: x?.bpp ?? null, msPorQuadro: x?.msPorQuadro ?? null, idrs: x?.idrs, pedidos: x?.pedidosDeChave,
      };
    };
    return;
  }

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

  throw new Error(`modo desconhecido: ${modo}`);
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
  const host = new BrowserWindow({
    show: true, width: 640, height: 360, title: `Tela D0 · injeção · ${n}`,
    webPreferences: { ...PREFERENCIAS, contextIsolation: false, preload: join(AQUI, 'espectador-preload.cjs') },
  });
  host.webContents.on('console-message', (ev) => {
    const msg = ev.message ?? ev;
    if (!/OpenH264|vite/i.test(String(msg))) console.log(`  [host] ${msg}`);
  });
  await host.loadURL(`${WEB}/@@d0`);
  console.log('  host carregado');
  const slug = `inj${Math.random().toString(36).slice(2, 8)}`;
  await host.webContents.executeJavaScript(
    `(${montarHost.toString()})(${JSON.stringify({ slug, modo: MODO })})`,
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
    if (process.env.TELA_D0_ISCA === '1') {
      const isca = await ler(host.webContents, `(async () => {
        const out = [];
        for (const pc of window.__pcs ?? []) {
          if (pc.connectionState !== 'connected') continue;
          (await pc.getStats()).forEach((x) => {
            if (x.type === 'outbound-rtp' && x.kind === 'video') out.push({
              w: x.frameWidth, h: x.frameHeight, chaves: x.keyFramesEncoded, pli: x.pliCount, fir: x.firCount,
              nack: x.nackCount, trocasRes: x.qualityLimitationResolutionChanges, lim: x.qualityLimitationReason,
              enc: x.encoderImplementation, fps: x.framesPerSecond,
            });
          });
        }
        return out;
      })()`, 'isca');
      console.log(`  isca: ${JSON.stringify(isca)}`);
    }
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
      idrsDecodificados: d.chaves - (antesV[i].chaves ?? 0),
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
