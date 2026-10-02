/**
 * Estudo de desempenho (docs/engenharia/estudo-desempenho.md, §5 e §8): quanto
 * custa ASSISTIR — o Chromium do espectador decodificando 720p60 e 1080p60 — e
 * quanto custa o `getStats()` do transmissor (B2 de complexidade.md), medido
 * em navegador real, headless, sem janela.
 *
 * Transmissor num Chromium próprio (`BroadcastSession` + "um encode", fonte
 * em canvas com movimento de tela cheia); espectadores em OUTRO Chromium, na
 * rota `/<canal>` de produção. CPU por árvore de processos (/proc, Linux).
 * No espectador, `inbound-rtp` dá `framesDecoded`, `totalDecodeTime`,
 * `decoderImplementation`, `powerEfficientDecoder`, jitter buffer e
 * congelamentos. No transmissor, `RTCPeerConnection.prototype.getStats` é
 * embrulhado antes de a sessão nascer, para contar chamadas, ms e objetos.
 *
 *   pnpm dev                                                       (noutro terminal)
 *   node e2e/bench/estudo-decode-espectador.mjs                    DEGRAUS=p720p60,p1080p60 ESPECTADORES=1 SEGUNDOS=20  OVERLAY=none|crt|blur
 *
 * Headless = SwiftShader, sem GPU: encode (OpenH264) e decode (FFmpeg) em
 * software. Os números são o PISO do custo em software; o caminho de hardware
 * só se mede com humano e `chrome://gpu` (AGENTS.md).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const DEGRAUS = (process.env.DEGRAUS ?? 'p720p60,p1080p60').split(',');
const ESPECTADORES = Number(process.env.ESPECTADORES ?? 1);
const SEGUNDOS = Number(process.env.SEGUNDOS ?? 20);
/** `none` | `crt` (scanlines + vinheta, o `.crt-vidro` de globals.css) | `blur` (backdrop-filter sobre o vídeo). */
const OVERLAY = process.env.OVERLAY ?? 'none';
const AQUECIMENTO = Number(process.env.AQUECIMENTO ?? 12);
const JSON_SAIDA = process.argv.includes('--json');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const TAMANHO = { p1080p60: [1920, 1080], p900p60: [1600, 900], p720p60: [1280, 720], p600p60: [1024, 576], p480p60: [854, 480], p360p60: [640, 360] };

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
      // processo sumiu
    }
  }
  const proprio = readFileSync(`/proc/${raiz}/stat`, 'utf8').split(') ')[1].split(' ');
  let total = Number(proprio[11]) + Number(proprio[12]);
  const pilha = [raiz];
  while (pilha.length > 0) {
    for (const f of filhos.get(pilha.pop()) ?? []) {
      total += f.ticks;
      pilha.push(f.pid);
    }
  }
  return total;
}

/** RSS somado da árvore, em MiB. */
function rssDaArvore(raiz) {
  const filhos = new Map();
  const rss = new Map();
  for (const nome of readdirSync('/proc')) {
    if (!/^\d+$/.test(nome)) continue;
    try {
      const c = readFileSync(`/proc/${nome}/stat`, 'utf8').split(') ')[1].split(' ');
      const pai = Number(c[1]);
      if (!filhos.has(pai)) filhos.set(pai, []);
      filhos.get(pai).push(Number(nome));
      rss.set(Number(nome), Number(c[21]) * 4096);
    } catch {
      // processo sumiu
    }
  }
  let total = rss.get(raiz) ?? 0;
  const pilha = [raiz];
  while (pilha.length > 0) for (const f of filhos.get(pilha.pop()) ?? []) { total += rss.get(f) ?? 0; pilha.push(f); }
  return total / 2 ** 20;
}

/**
 * O Playwright não expõe `browser.process()`. Marca o Chromium com um argumento
 * inócuo e procura em /proc o processo raiz (sem `--type=`) que o carrega.
 */
function pidDaRaiz(marca) {
  for (const nome of readdirSync('/proc')) {
    if (!/^\d+$/.test(nome)) continue;
    try {
      const cmd = readFileSync(`/proc/${nome}/cmdline`, 'utf8');
      if (cmd.includes(marca) && !cmd.includes('--type=')) return Number(nome);
    } catch {
      // processo sumiu
    }
  }
  return undefined;
}

const GANCHO_PCS = `
  (() => {
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    window.__getStats = { chamadas: 0, ms: 0, objetos: 0 };
    const getStats = Orig.prototype.getStats;
    Orig.prototype.getStats = async function (...a) {
      const t0 = performance.now();
      const r = await getStats.apply(this, a);
      window.__getStats.chamadas += 1;
      window.__getStats.ms += performance.now() - t0;
      window.__getStats.objetos += r.size;
      return r;
    };
    window.RTCPeerConnection = new Proxy(Orig, {
      construct(alvo, args) { const pc = new alvo(...args); window.__pcs.push(pc); return pc; },
    });
  })();
`;

async function lerInbound(pagina) {
  return pagina.evaluate(async () => {
    const saida = { pcs: window.__pcs?.length ?? 0 };
    for (const pc of window.__pcs ?? []) {
      const rel = await pc.getStats();
      for (const s of rel.values()) {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          Object.assign(saida, {
            framesDecoded: s.framesDecoded, framesDropped: s.framesDropped, framesReceived: s.framesReceived,
            totalDecodeTime: s.totalDecodeTime, totalProcessingDelay: s.totalProcessingDelay, totalAssemblyTime: s.totalAssemblyTime,
            jitterBufferDelay: s.jitterBufferDelay, jitterBufferEmittedCount: s.jitterBufferEmittedCount,
            jitterBufferTargetDelay: s.jitterBufferTargetDelay, jitterBufferMinimumDelay: s.jitterBufferMinimumDelay,
            freezeCount: s.freezeCount, totalFreezesDuration: s.totalFreezesDuration, pauseCount: s.pauseCount,
            frameWidth: s.frameWidth, frameHeight: s.frameHeight, framesPerSecond: s.framesPerSecond,
            decoderImplementation: s.decoderImplementation, powerEfficientDecoder: s.powerEfficientDecoder,
            keyFramesDecoded: s.keyFramesDecoded, pliCount: s.pliCount, nackCount: s.nackCount, packetsLost: s.packetsLost,
            googTimingFrameInfo: s.googTimingFrameInfo, camposNaoPadrao: Object.keys(s).filter((k) => k.startsWith('goog')),
            bytesReceived: s.bytesReceived, timestamp: s.timestamp,
          });
        }
      }
    }
    return saida;
  });
}

async function medir(degrau) {
  const [W, H] = TAMANHO[degrau] ?? [1280, 720];
  const marca = `tela-estudo-${process.pid}-${Date.now()}`;
  const hostBrowser = await chromium.launch({ headless: true, args: [`--tela-marca=${marca}-h`] });
  const viewerBrowser = await chromium.launch({ headless: true, args: [`--tela-marca=${marca}-v`] });
  try {
    const hostCtx = await hostBrowser.newContext();
    await hostCtx.addInitScript(GANCHO_PCS);
    const host = await hostCtx.newPage();
    await host.goto(`${WEB}/@@bench`, { waitUntil: 'networkidle' });
    const slug = `es${Math.random().toString(36).slice(2, 8)}`;
    const subiu = await host.evaluate(async ({ canal, W, H, degrau }) => {
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { alpha: false });
      let t = 0;
      // Movimento de tela cheia (gradiente que anda + blocos): entropia alta, como gameplay.
      setInterval(() => {
        t += 1;
        const g = ctx.createLinearGradient((t * 7) % W, 0, ((t * 7) % W) + W / 2, H);
        g.addColorStop(0, `hsl(${t % 360} 80% 35%)`);
        g.addColorStop(1, `hsl(${(t * 3) % 360} 80% 65%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        for (let i = 0; i < 24; i += 1) {
          ctx.fillStyle = `hsl(${(i * 37 + t * 5) % 360} 90% 50%)`;
          ctx.fillRect(((i * 211 + t * (3 + i)) % (W + 100)) - 50, ((i * 131 + t * (2 + (i % 5))) % (H + 100)) - 50, 90, 90);
        }
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
      await session.start(canal, `es${'b'.repeat(41)}`, { presetId: degrau });
      return session.getState().status;
    }, { canal: slug, W, H, degrau });
    if (subiu !== 'live') throw new Error(`host não subiu: ${subiu}`);

    const viewerCtx = await viewerBrowser.newContext();
    await viewerCtx.addInitScript(GANCHO_PCS);
    const paginas = [];
    for (let i = 0; i < ESPECTADORES; i += 1) {
      const p = await viewerCtx.newPage();
      await p.goto(`${WEB}/${slug}`, { waitUntil: 'domcontentloaded' });
      paginas.push(p);
    }
    await esperar(AQUECIMENTO * 1000);
    if (OVERLAY !== 'none') {
      await Promise.all(paginas.map((p) => p.evaluate((modo) => {
        const d = document.createElement('div');
        d.setAttribute('aria-hidden', 'true');
        d.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;';
        if (modo === 'crt') d.style.background = 'radial-gradient(ellipse at center, transparent 62%, rgb(0 0 0 / 0.32) 100%), repeating-linear-gradient(to bottom, rgb(0 0 0 / 0.16) 0 1px, transparent 1px 3px)';
        if (modo === 'blur') { d.style.background = 'rgb(0 0 0 / 0.05)'; d.style.backdropFilter = 'blur(8px)'; }
        document.body.appendChild(d);
      }, OVERLAY)));
    }
    // Trabalho da thread principal do espectador (CDP): TaskDuration é o relógio de parede ocupado.
    const cdp = await viewerCtx.newCDPSession(paginas[0]);
    await cdp.send('Performance.enable');
    const metrica = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const m0 = await metrica();
    // Quadro a quadro, pelo rVFC (a mesma API de `use-frame-latency`). Mesmo relógio nos dois
    // Chromiums (mesma máquina), então `expectedDisplayTime - captureTime` é a latência de software
    // ponta a ponta SEM câmera, captura de tela real e monitor — só o que o produto controla.
    await paginas[0].evaluate(() => {
      const v = document.querySelector('video');
      window.__rvfc = { n: 0, comCaptura: 0, comRecepcao: 0, g2g: [], recepcaoAteExibir: [], proc: [], intervalos: [], ultimo: 0 };
      const passo = (_n, m) => {
        const a = window.__rvfc;
        a.n += 1;
        if (m.expectedDisplayTime && a.ultimo) a.intervalos.push(m.expectedDisplayTime - a.ultimo);
        a.ultimo = m.expectedDisplayTime ?? 0;
        if (m.captureTime !== undefined) { a.comCaptura += 1; a.g2g.push(m.expectedDisplayTime - m.captureTime); }
        if (m.receiveTime !== undefined) { a.comRecepcao += 1; a.recepcaoAteExibir.push(m.expectedDisplayTime - m.receiveTime); }
        if (m.processingDuration !== undefined) a.proc.push(m.processingDuration * 1000);
        v.requestVideoFrameCallback(passo);
      };
      if (v) v.requestVideoFrameCallback(passo);
    });

    const pidV = pidDaRaiz(`${marca}-v`);
    const pidH = pidDaRaiz(`${marca}-h`);
    const antes = await lerInbound(paginas[0]);
    const gs0 = await host.evaluate(() => ({ ...window.__getStats }));
    const tV0 = ticksDaArvore(pidV);
    const tH0 = ticksDaArvore(pidH);
    const inicio = Date.now();
    await esperar(SEGUNDOS * 1000);
    const dt = (Date.now() - inicio) / 1000;
    const nucleosViewer = (ticksDaArvore(pidV) - tV0) / 100 / dt;
    const nucleosHost = (ticksDaArvore(pidH) - tH0) / 100 / dt;
    const depois = await lerInbound(paginas[0]);
    const m1 = await metrica();
    const rv = await paginas[0].evaluate(() => {
      const a = window.__rvfc;
      const q = (xs, p) => { if (xs.length === 0) return null; const o = [...xs].sort((x, y) => x - y); return o[Math.min(o.length - 1, Math.floor(p * o.length))]; };
      const sdp = window.__pcs?.[0]?.remoteDescription?.sdp ?? '';
      const v = sdp.split('m=video')[1] ?? '';
      const extmaps = [...new Set([...v.matchAll(/a=extmap:\d+ (\S+)/g)].map((m) => m[1].replace('http://www.webrtc.org/experiments/rtp-hdrext/', 'webrtc:').replace('http://www.ietf.org/id/draft-holmer-rmcat-', 'rmcat:')))];
      return { extmaps, quadros: a.n, comCaptura: a.comCaptura, comRecepcao: a.comRecepcao, g2gP50: q(a.g2g, 0.5), g2gP95: q(a.g2g, 0.95), recepcaoP50: q(a.recepcaoAteExibir, 0.5), recepcaoP95: q(a.recepcaoAteExibir, 0.95), procP50: q(a.proc, 0.5), intervaloP50: q(a.intervalos, 0.5), intervaloP95: q(a.intervalos, 0.95) };
    });
    const gs1 = await host.evaluate(() => ({ ...window.__getStats }));
    const rssViewer = rssDaArvore(pidV);
    const hostEstado = await host.evaluate(() => {
      const s = window.__sessao.getState();
      return { degrau: s.presetId, saida: `${s.stats?.width}x${s.stats?.height}@${Math.round(s.stats?.fps ?? 0)}`, bitrate: s.stats?.bitrateBps, bpp: s.stats?.bpp, conectados: s.peers.filter((p) => p.connectionState === 'connected').length };
    });

    // Varredura do piso do jitter buffer (`RTCRtpReceiver.jitterBufferTarget`), em ms, na mesma sessão.
    const varredura = [];
    for (const alvo of (process.env.JITTER_SWEEP ?? '').split(',').filter((x) => x !== '')) {
      await paginas[0].evaluate((ms) => {
        for (const pc of window.__pcs) for (const r of pc.getReceivers()) if (r.track?.kind === 'video') { r.jitterBufferTarget = Number(ms); if ('playoutDelayHint' in r) r.playoutDelayHint = Number(ms) / 1000; }
      }, alvo);
      await esperar(4000);
      const a = await lerInbound(paginas[0]);
      const tl = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        const x = await lerInbound(paginas[0]);
        const c = String(x.googTimingFrameInfo ?? '').split(',').map(Number);
        if (c.length === 15) tl.push({ jitterBuf: c[10] - c[9], decode: c[11] - c[10], render: c[12] - c[11] });
        await esperar(250);
      }
      const b = await lerInbound(paginas[0]);
      const n = b.jitterBufferEmittedCount - a.jitterBufferEmittedCount;
      const med = (xs) => (xs.length === 0 ? null : [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]);
      varredura.push({ alvoMs: Number(alvo), jitterBufferMs: ((b.jitterBufferDelay - a.jitterBufferDelay) * 1000) / n, jitterBufferMinimoMs: ((b.jitterBufferMinimumDelay - a.jitterBufferMinimumDelay) * 1000) / n, jitterBufferAlvoMs: ((b.jitterBufferTargetDelay - a.jitterBufferTargetDelay) * 1000) / n, processingMs: ((b.totalProcessingDelay - a.totalProcessingDelay) * 1000) / (b.framesDecoded - a.framesDecoded), timingMediana: { jitterBuf: med(tl.map((t) => t.jitterBuf)), decode: med(tl.map((t) => t.decode)), decodeAteRender: med(tl.map((t) => t.render)), amostras: tl.length }, congelamentos: b.freezeCount - a.freezeCount, descartados: b.framesDropped - a.framesDropped, fps: (b.framesDecoded - a.framesDecoded) / ((b.timestamp - a.timestamp) / 1000) });
    }

    const quadros = (depois.framesDecoded ?? 0) - (antes.framesDecoded ?? 0);
    const decodeMsPorQuadro = quadros > 0 ? ((depois.totalDecodeTime - antes.totalDecodeTime) * 1000) / quadros : null;
    const jbEmit = (depois.jitterBufferEmittedCount ?? 0) - (antes.jitterBufferEmittedCount ?? 0);
    const jbMs = jbEmit > 0 ? ((depois.jitterBufferDelay - antes.jitterBufferDelay) * 1000) / jbEmit : null;
    const procMs = quadros > 0 ? ((depois.totalProcessingDelay - antes.totalProcessingDelay) * 1000) / quadros : null;
    const asmMs = quadros > 0 && depois.totalAssemblyTime !== undefined ? ((depois.totalAssemblyTime - antes.totalAssemblyTime) * 1000) / quadros : null;
    const chamadas = gs1.chamadas - gs0.chamadas;
    return {
      degrau,
      varredura,
      espectadores: ESPECTADORES,
      segundos: dt,
      host: { ...hostEstado, nucleos: nucleosHost, getStats: { chamadas, msPorChamada: chamadas > 0 ? (gs1.ms - gs0.ms) / chamadas : null, objetosPorChamada: chamadas > 0 ? (gs1.objetos - gs0.objetos) / chamadas : null, msPorSegundo: (gs1.ms - gs0.ms) / dt } },
      espectador: {
        overlay: OVERLAY,
        timingDoQuadro: { amostra: depois.googTimingFrameInfo ?? null, campos: depois.camposNaoPadrao },
        rvfc: rv,
        mainThread: { tarefaMsPorS: ((m1.TaskDuration - m0.TaskDuration) * 1000) / dt, scriptMsPorS: ((m1.ScriptDuration - m0.ScriptDuration) * 1000) / dt, layoutMsPorS: ((m1.LayoutDuration - m0.LayoutDuration) * 1000) / dt, estiloMsPorS: ((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000) / dt },
        nucleosTotal: nucleosViewer,
        nucleosPorEspectador: nucleosViewer / ESPECTADORES,
        rssMiB: rssViewer,
        recebido: `${depois.frameWidth}x${depois.frameHeight}`,
        fpsDecodificado: quadros / dt,
        fpsReportado: depois.framesPerSecond,
        decodeMsPorQuadro,
        jitterBufferMsPorQuadro: jbMs,
        jitterBufferTargetMs: jbEmit > 0 ? ((depois.jitterBufferTargetDelay - antes.jitterBufferTargetDelay) * 1000) / jbEmit : null,
        processingDelayMsPorQuadro: procMs,
        assemblyMsPorQuadro: asmMs,
        decoder: depois.decoderImplementation,
        powerEfficientDecoder: depois.powerEfficientDecoder,
        congelamentos: (depois.freezeCount ?? 0) - (antes.freezeCount ?? 0),
        descartados: (depois.framesDropped ?? 0) - (antes.framesDropped ?? 0),
        chaves: (depois.keyFramesDecoded ?? 0) - (antes.keyFramesDecoded ?? 0),
        pli: (depois.pliCount ?? 0) - (antes.pliCount ?? 0),
        nack: (depois.nackCount ?? 0) - (antes.nackCount ?? 0),
        perdidos: (depois.packetsLost ?? 0) - (antes.packetsLost ?? 0),
        mbps: ((depois.bytesReceived - antes.bytesReceived) * 8) / dt / 1e6,
      },
    };
  } finally {
    await viewerBrowser.close();
    await hostBrowser.close();
  }
}

const f = (x, c = 2) => (x === null || x === undefined || Number.isNaN(x) ? 'n/d' : Number(x).toFixed(c).replace('.', ','));
if (!JSON_SAIDA) console.log(`\nCusto de assistir (Chromium headless, software), ${SEGUNDOS}s por degrau, aquecimento ${AQUECIMENTO}s, ${ESPECTADORES} espectador(es)\n`);
for (const degrau of DEGRAUS) {
  const r = await medir(degrau);
  if (JSON_SAIDA) {
    console.log(JSON.stringify(r));
    continue;
  }
  const e = r.espectador;
  console.log(`${degrau}: host envia ${r.host.saida} ${f(r.host.bitrate / 1e6, 1)} Mbps bpp ${f(r.host.bpp, 3)} · host ${f(r.host.nucleos, 3)} núcleo`);
  console.log(`  espectador: ${f(e.nucleosPorEspectador, 3)} núcleo · RSS ${f(e.rssMiB, 0)} MiB · recebe ${e.recebido} a ${f(e.fpsDecodificado, 1)} fps (${f(e.mbps, 1)} Mbps) · decoder ${e.decoder} powerEfficient=${e.powerEfficientDecoder}`);
  console.log(`  thread principal do espectador (por s): tarefas ${f(e.mainThread.tarefaMsPorS, 1)} ms · script ${f(e.mainThread.scriptMsPorS, 1)} ms · layout ${f(e.mainThread.layoutMsPorS, 2)} ms · estilo ${f(e.mainThread.estiloMsPorS, 2)} ms · overlay ${e.overlay}`);
  for (const v of r.varredura) console.log(`  piso ${v.alvoMs} ms: jitter buffer ${f(v.jitterBufferMs, 1)} ms (mínimo da rede ${f(v.jitterBufferMinimoMs, 1)}, alvo ${f(v.jitterBufferAlvoMs, 1)}) · processing ${f(v.processingMs, 1)} ms · googTiming mediana: buffer ${v.timingMediana.jitterBuf} + decode ${v.timingMediana.decode} + decode→render ${v.timingMediana.decodeAteRender} ms (${v.timingMediana.amostras} amostras) · fps ${f(v.fps, 1)} · congelamentos ${v.congelamentos} · descartados ${v.descartados}`);
  console.log(`  googTimingFrameInfo: ${JSON.stringify(e.timingDoQuadro)}`);
  console.log(`  extmap de vídeo negociadas: ${e.rvfc.extmaps.join(', ')}`);
  console.log(`  rVFC: ${e.rvfc.quadros} quadros · com captureTime ${e.rvfc.comCaptura} · com receiveTime ${e.rvfc.comRecepcao} · captura→exibição p50 ${f(e.rvfc.g2gP50, 1)} p95 ${f(e.rvfc.g2gP95, 1)} ms · recepção→exibição p50 ${f(e.rvfc.recepcaoP50, 1)} p95 ${f(e.rvfc.recepcaoP95, 1)} ms · processingDuration p50 ${f(e.rvfc.procP50, 2)} ms · intervalo de exibição p50 ${f(e.rvfc.intervaloP50, 1)} p95 ${f(e.rvfc.intervaloP95, 1)} ms`);
  console.log(`  por quadro: decode ${f(e.decodeMsPorQuadro)} ms · jitter buffer ${f(e.jitterBufferMsPorQuadro)} ms (alvo ${f(e.jitterBufferTargetMs)}) · processing ${f(e.processingDelayMsPorQuadro)} ms · assembly ${f(e.assemblyMsPorQuadro)} ms`);
  console.log(`  eventos em ${f(r.segundos, 0)}s: congelamentos ${e.congelamentos} · descartados ${e.descartados} · chaves ${e.chaves} · PLI ${e.pli} · NACK ${e.nack} · perdidos ${e.perdidos}`);
  console.log(`  getStats() no host: ${r.host.getStats.chamadas} chamadas, ${f(r.host.getStats.msPorChamada)} ms/chamada, ${f(r.host.getStats.objetosPorChamada, 0)} objetos/chamada, ${f(r.host.getStats.msPorSegundo)} ms/s\n`);
}
