/**
 * Latência captura→tela MEDIDA, nos dois transportes (mesh puro e "um encode").
 *
 * O que fecha a conta: o transmissor negocia `abs-capture-time`
 * (`PeerLink.negociarCapturaAbsoluta`); o espectador lê o `captureTimestamp`
 * por `getSynchronizationSources()` — o `captureTime` do rVFC o Chromium não
 * preenche em vídeo remoto, e este script CONTA isso (`nativo`).
 *
 * Por quadro, no espectador (página real, rota `/<canal>`):
 *   atraso = (timeOrigin + expectedDisplayTime) − (captureTimestamp extrapolado
 *            pelo rtpTimestamp)
 * e confere o offset de relógio estimado pelo RTCP (SR + RTT/2). Mesma máquina:
 * o offset verdadeiro é 0, então o estimado tem de ficar perto disso.
 *
 * Duas cenas por transporte:
 *   carga   30 fps, 1280x720, conteúdo pesado — o atraso de verdade;
 *   esparsa 5 fps, um quadro a cada 200 ms, com o instante de cada desenho
 *           registrado — mede o ERRO do carimbo (quanto o `captureTimestamp`
 *           anda depois do instante em que a fonte produziu o quadro). No
 *           "um encode" o carimbo é o da ISCA, e o instante do tique do
 *           codificador único também é registrado.
 *
 * LIMITES (AGENTS.md): mesma máquina, headless, codec de software (OpenH264/
 * FFmpeg), sem tela real, sem rede real. Os números dizem "o pipeline de
 * software soma X"; não valem para latência glass-to-glass (humano, câmera 240fps).
 *
 *   pnpm dev                      (noutro terminal)
 *   node e2e/latencia.e2e.mjs     MODOS=mesh,um-encode SEGUNDOS=20
 */
import { chromium } from 'playwright';

const CHROME = process.env.CHROME ?? chromium.executablePath();
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const MODOS = (process.env.MODOS ?? 'mesh,um-encode').split(',');
const SEGUNDOS = Number(process.env.SEGUNDOS ?? 20);
const AQUECIMENTO_MS = Number(process.env.AQUECIMENTO_MS ?? 8000);
const COBERTURA_MINIMA = 0.95;

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (n, c = 1) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(c) : '—');
const pct = (v, p) => {
  const o = v.filter(Number.isFinite).sort((a, b) => a - b);
  return o.length === 0 ? NaN : o[Math.min(o.length - 1, Math.max(0, Math.ceil(o.length * p) - 1))];
};
const med = (v) => pct(v, 0.5);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

/** Guarda as PCs e mede cada quadro apresentado do `<video>`. */
const instrumentarEspectador = () => {
  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = class extends Original {
    constructor(...a) {
      super(...a);
      window.__pcs.push(this);
    }
  };
  const NTP = 2_208_988_800_000;
  const M = (window.__m = { quadros: 0, nativo: 0, comCaptura: 0, lat: [], caps: [], offsets: [], rtts: [] });
  const doReceptor = () => {
    for (const pc of window.__pcs) {
      if (pc.connectionState !== 'connected') continue;
      const rx = pc.getReceivers().find((r) => r.track.kind === 'video');
      if (rx) return { pc, rx };
    }
    return null;
  };
  // Offset de relógio por RTCP: mesma conta do `RelogioDeCaptura`, reescrita à mão.
  let offset = null;
  setInterval(async () => {
    const r = doReceptor();
    if (!r) return;
    const rep = await r.pc.getStats();
    let sr = null;
    let rtt = 0;
    rep.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && typeof s.currentRoundTripTime === 'number') rtt = s.currentRoundTripTime * 1000;
      if (s.type === 'remote-outbound-rtp' && s.kind === 'video') sr = s;
    });
    if (!sr) return;
    const o = sr.timestamp - sr.remoteTimestamp - rtt / 2;
    M.offsets.push(o);
    M.rtts.push(rtt);
    const recentes = M.offsets.slice(-15).sort((a, b) => a - b);
    offset = recentes[recentes.length >> 1];
  }, 1000);
  setInterval(() => {
    const v = document.querySelector('video');
    if (!v || v.__medido || typeof v.requestVideoFrameCallback !== 'function') return;
    v.__medido = true;
    const passo = (_now, meta) => {
      const r = doReceptor();
      M.quadros += 1;
      if (meta.captureTime !== undefined) M.nativo += 1;
      const ss = r?.rx.getSynchronizationSources().find((s) => typeof s.captureTimestamp === 'number');
      if (ss && meta.rtpTimestamp !== undefined) {
        const cap = (ss.captureTimestamp > 2.5e12 ? ss.captureTimestamp - NTP : ss.captureTimestamp) + ((meta.rtpTimestamp - ss.rtpTimestamp) | 0) / 90;
        const exib = performance.timeOrigin + meta.expectedDisplayTime;
        M.comCaptura += 1;
        M.lat.push(exib - cap); // offset verdadeiro = 0 (mesma máquina)
        M.caps.push(cap);
      }
      v.requestVideoFrameCallback(passo);
    };
    v.requestVideoFrameCallback(passo);
  }, 300);
};

async function nova(rotulo, instrumentar) {
  const ctx = await browser.newContext();
  if (instrumentar) await ctx.addInitScript(instrumentar);
  else await ctx.addInitScript(() => { window.__pcs = []; });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${rotulo}] pageerror: ${e.message}`));
  return p;
}

/** Sobe a BroadcastSession de verdade sobre o transporte pedido. */
const subirTransmissor = (host, canal, modo, cena) =>
  host.evaluate(
    async ([canal, modo, cena]) => {
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
      const desenhar = (t) => {
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.rotate(Math.sin(t * 0.7) * 0.2);
        ctx.drawImage(mundo, -1200 + Math.sin(t) * 400, -800 + Math.cos(t * 0.8) * 300);
        ctx.restore();
      };
      window.__desenhos = [];
      window.__tiques = [];
      let video;
      if (cena === 'esparsa') {
        // Um quadro por 200 ms; o instante é registrado ANTES de desenhar. O
        // canvas só emite quadro quando muda, então a fonte tem 5 fps.
        video = canvas.captureStream(30).getVideoTracks()[0];
        let t = 0;
        setInterval(() => {
          t += 0.2;
          window.__desenhos.push(Date.now());
          desenhar(t);
        }, 200);
      } else {
        let t = 0;
        setInterval(() => {
          t += 1 / 30;
          desenhar(t);
        }, 1000 / 30);
        video = canvas.captureStream(30).getVideoTracks()[0];
      }

      const { BroadcastSession } = await import('/src/core/media/broadcast-session.ts');
      const { makeEncodeOnceTransport } = await import('/src/adapters/encode-once-transport.ts');
      const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
      const { CodificadorWebCodecs } = await import('/src/adapters/webcodecs-codificador.ts');
      const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
      const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
      const { makeBrowserAudioGain } = await import('/src/adapters/browser-audio-gain.ts');
      const scheduler = makeBrowserScheduler();
      const channel = makeWsSignaling(`ws://${location.host}/signal`);
      const transport =
        modo === 'um-encode'
          ? makeEncodeOnceTransport({
              channel,
              scheduler,
              criarWorker: () => new Worker(new URL('/src/adapters/injecao-worker.ts', location.origin), { type: 'module' }),
              // Mesmo codificador de produção; só registra o instante do tique da isca.
              criarCodificador: (d) =>
                new CodificadorWebCodecs(d.entregar, () => performance.now(), () => {
                  window.__tiques.push(Date.now());
                  d.aoCapturar();
                }),
            })
          : makeMeshTransport({ channel, scheduler });
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
      await session.start(canal, `e2e${Math.random().toString(36).slice(2).padEnd(40, 'l')}`, { presetId: 'p720p60' });
      const st = session.getState();
      return st.status === 'ended' ? `ended:${st.reason}` : st.status;
    },
    [canal, modo, cena],
  );

const resultados = [];

for (const modo of MODOS) {
  for (const cena of ['carga', 'esparsa']) {
    console.log(`\n=== ${modo} · ${cena} ===`);
    const slug = `lt${Math.random().toString(36).slice(2, 8)}`;
    let host;
    let status = '';
    // O signaling é compartilhado com outros e2e na máquina: uma partida que
    // nasce `ended` (visto uma vez em ~10) é refeita, e o motivo vai ao log.
    for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
      host = await nova('host', null);
      await host.goto(`${WEB}/@@e2e`, { waitUntil: 'networkidle' });
      status = await subirTransmissor(host, slug, modo, cena);
      if (status === 'live') break;
      console.log(`  tentativa ${tentativa}: ${status}`);
      await host.context().close();
    }
    ok(status === 'live', `transmissor no ar (${status})`);

    const v = await nova('espectador', instrumentarEspectador);
    await v.goto(`${WEB}/${slug}`, { waitUntil: 'domcontentloaded' });
    await esperar(AQUECIMENTO_MS);
    await v.evaluate(() => {
      const M = window.__m;
      M.quadros = 0; M.nativo = 0; M.comCaptura = 0; M.lat = []; M.caps = [];
    });
    const dur = cena === 'carga' ? SEGUNDOS : Math.min(SEGUNDOS, 15);
    await esperar(dur * 1000);

    const M = await v.evaluate(() => window.__m);
    const hud = await v.evaluate(() => {
      const el = [...document.querySelectorAll('[title]')].find((e) => /captura até a tela|só a recepção/.test(e.getAttribute('title') ?? ''));
      return el ? { titulo: el.getAttribute('title'), texto: el.textContent } : null;
    });
    const desenhos = await host.evaluate(() => window.__desenhos);
    const tiques = await host.evaluate(() => window.__tiques);

    const cobertura = M.quadros === 0 ? 0 : M.comCaptura / M.quadros;
    console.log(`  quadros ${M.quadros} · rVFC.captureTime nativo ${M.nativo} (${f((100 * M.nativo) / Math.max(1, M.quadros))}%) · captureTimestamp via RTP ${M.comCaptura} (${f(100 * cobertura)}%)`);
    ok(M.quadros >= 30, `espectador apresenta quadros (${M.quadros})`);
    ok(cobertura >= COBERTURA_MINIMA, `captureTimestamp presente em >= 95% dos quadros (${f(100 * cobertura)}%)`);
    const offs = M.offsets.slice(-15);
    console.log(`  offset de relógio estimado (SR − RTT/2): mediana ${f(med(offs), 2)} ms · RTT ${f(med(M.rtts), 2)} ms (verdadeiro: 0)`);
    ok(Math.abs(med(offs)) < 5, `offset estimado perto do verdadeiro (|${f(med(offs), 2)}| < 5 ms)`);

    const r = { modo, cena, quadros: M.quadros, cobertura, nativo: M.nativo, offsetMs: med(offs) };
    if (cena === 'carga') {
      r.mediana = med(M.lat);
      r.p95 = pct(M.lat, 0.95);
      r.max = pct(M.lat, 1);
      console.log(`  capture→display: mediana ${f(r.mediana)} ms · p95 ${f(r.p95)} ms · max ${f(r.max)} ms (n=${M.lat.length})`);
      ok(r.mediana > 0 && r.mediana < 1000, `mediana plausível (${f(r.mediana)} ms)`);
      // O HUD de produção, pelo mesmo caminho do espectador de verdade.
      ok(hud !== null && /captura até a tela/.test(hud.titulo), `HUD usa a origem "captura" (${hud ? JSON.stringify(hud) : 'sem HUD no DOM'})`);
    } else {
      const antes = (lista, t) => {
        let melhor = null;
        for (const x of lista) if (x <= t + 2 && (melhor === null || x > melhor)) melhor = x;
        return melhor;
      };
      const contra = (lista) => M.caps.map((c) => { const t = antes(lista, c); return t === null ? NaN : c - t; }).filter((x) => Number.isFinite(x) && x < 150);
      const dDesenho = contra(desenhos);
      r.carimboVsDesenho = { mediana: med(dDesenho), p95: pct(dDesenho, 0.95), min: pct(dDesenho, 0), max: pct(dDesenho, 1), n: dDesenho.length };
      console.log(`  carimbo − desenho da fonte: mediana ${f(r.carimboVsDesenho.mediana)} ms · p95 ${f(r.carimboVsDesenho.p95)} · min ${f(r.carimboVsDesenho.min)} · max ${f(r.carimboVsDesenho.max)} (n=${dDesenho.length})`);
      if (modo === 'um-encode') {
        const dTique = contra(tiques);
        r.carimboVsTique = { mediana: med(dTique), p95: pct(dTique, 0.95), min: pct(dTique, 0), max: pct(dTique, 1), n: dTique.length };
        console.log(`  carimbo da ISCA − tique do codificador único (quadro real): mediana ${f(r.carimboVsTique.mediana)} ms · p95 ${f(r.carimboVsTique.p95)} · min ${f(r.carimboVsTique.min)} · max ${f(r.carimboVsTique.max)} (n=${dTique.length})`);
      }
    }
    resultados.push(r);
    await host.context().close();
    await v.context().close();
  }
}

console.log('\nRESUMO ' + JSON.stringify(resultados));
await browser.close();
console.log(process.exitCode ? '\n=== LATENCIA FALHOU ===' : '\n=== LATENCIA PASSOU ===');
