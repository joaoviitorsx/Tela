/**
 * "Um encode, N envios" (D0b) em Chrome real, contra o espectador de produção.
 *
 * O transmissor é a `BroadcastSession` de verdade — malhas, governador — sobre
 * `makeEncodeOnceTransport`: um `VideoEncoder` codifica a fonte uma vez, cada
 * sender codifica só uma isca 32x18, e um Encoded Transform troca o conteúdo.
 * Os espectadores são a rota `/<canal>`, sem saber de nada.
 *
 * Critérios: os espectadores DECODIFICAM vídeo (resolução e fps reais, do
 * `inbound-rtp`), sem reconexão, sem rajada de quadros-chave; e a isca não gera
 * quadro-chave sozinha (o defeito que derrubava tudo a 20 fps).
 *
 *   pnpm dev                       (noutro terminal)
 *   node e2e/um-encode.e2e.mjs
 */
import { chromium } from 'playwright';

const CHROME = process.env.CHROME ?? chromium.executablePath();
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const ESPECTADORES = Number(process.env.ESPECTADORES ?? 2);
/** `AV1=1`: o codificador único em AV1 por SOFTWARE (só teste; ADR 0035). */
const AV1 = process.env.AV1 === '1';
/**
 * `AV1_ESPECTADOR=0`: espectadores sem a chave de teste, como um aparelho sem
 * decoder AV1 eficiente — recusam AV1 na resposta e a sala fica em H.264.
 */
const AV1_ESPECTADOR = AV1 && process.env.AV1_ESPECTADOR !== '0';
const SEGUNDOS = Number(process.env.SEGUNDOS ?? 30);

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

/** Guarda as RTCPeerConnection da página, para ler `inbound-rtp`/`outbound-rtp`. */
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

async function pagina(rotulo) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(guardarPcs);
  // Espectador headless decodifica AV1 por software: sem isto ele o recusaria (ADR 0035).
  if (AV1_ESPECTADOR && rotulo !== 'host') await ctx.addInitScript(() => localStorage.setItem('tela.av1', 'forcar'));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${rotulo}] pageerror: ${e.message}`));
  return p;
}

const slug = `um${Math.random().toString(36).slice(2, 8)}`;
const host = await pagina('host');
await host.goto(`${WEB}/@@e2e`, { waitUntil: 'networkidle' });

console.log('\n1. Transmissor: BroadcastSession sobre o transporte "um encode"');
const subiu = await host.evaluate(async ([canal, av1]) => {
  // Fonte com cara de jogo: mundo deslocado e girado, partículas por cima.
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
  const { CodificadorWebCodecs } = await import('/src/adapters/webcodecs-codificador.ts');
  const scheduler = makeBrowserScheduler();
  const session = new BroadcastSession({
    transport: makeEncodeOnceTransport({
      channel: makeWsSignaling(`ws://${location.host}/signal`),
      scheduler,
      criarWorker: () => new Worker(new URL('/src/adapters/injecao-worker.ts', location.origin), { type: 'module' }),
      ...(av1
        ? { criarCodificador: (d) => new CodificadorWebCodecs(d.entregar, () => performance.now(), d.aoCapturar, { av1: 'forcado' }) }
        : {}),
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
}, [slug, AV1]);
ok(subiu === 'live', `sessão no ar (${subiu})`);

const espectadores = [];
for (let i = 0; i < ESPECTADORES; i += 1) {
  const v = await pagina(`espectador${i}`);
  await v.goto(`${WEB}/${slug}`, { waitUntil: 'domcontentloaded' });
  espectadores.push(v);
}

const lerEspectador = (p) => p.evaluate(async () => {
  const r = { pcs: (window.__pcs ?? []).length };
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState !== 'connected') continue;
    (await pc.getStats()).forEach((s) => {
      if (s.type === 'codec') r.codecs = { ...(r.codecs ?? {}), [s.id]: s.mimeType };
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        Object.assign(r, { w: s.frameWidth, h: s.frameHeight, dec: s.framesDecoded, chaves: s.keyFramesDecoded, plis: s.pliCount, cong: s.freezeCount, codecId: s.codecId });
      }
    });
  }
  return r;
});
const lerIscas = () => host.evaluate(async () => {
  const out = [];
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState !== 'connected') continue;
    (await pc.getStats()).forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') out.push({ w: s.frameWidth, chaves: s.keyFramesEncoded, pli: s.pliCount, fir: s.firCount });
    });
  }
  return out;
});

console.log(`\n2. ${ESPECTADORES} espectador(es) entram; ${SEGUNDOS}s de medição depois do aquecimento`);
await esperar(15_000);
const antes = await Promise.all(espectadores.map(lerEspectador));
await esperar(SEGUNDOS * 1000);
const depois = await Promise.all(espectadores.map(lerEspectador));
const iscas = await lerIscas();
const estado = await host.evaluate(() => {
  const s = window.__sessao.getState();
  return s.status === 'live' ? { degrau: s.presetId, enc: s.stats?.encoderImplementation, w: s.stats?.width, h: s.stats?.height } : { status: s.status };
});
console.log(`   transmissor: ${JSON.stringify(estado)}`);

depois.forEach((d, i) => {
  const a = antes[i];
  const fps = ((d.dec ?? 0) - (a.dec ?? 0)) / SEGUNDOS;
  const chaves = (d.chaves ?? 0) - (a.chaves ?? 0);
  console.log(`   espectador ${i}: ${d.w}x${d.h} · ${fps.toFixed(1)} fps decodificados · ${chaves} chave(s) · conexões ${d.pcs}`);
  ok(d.w >= 640 && d.h >= 360, `espectador ${i} recebe vídeo de verdade (${d.w}x${d.h})`);
  ok(fps >= 20, `espectador ${i} decodifica com fluidez (${fps.toFixed(1)} fps; a fonte é 30)`);
  ok(d.pcs === 1, `espectador ${i} não reconectou (${d.pcs} conexão(ões))`);
  ok(chaves <= 3, `espectador ${i} sem rajada de quadros-chave (${chaves} em ${SEGUNDOS}s)`);
});
if (AV1_ESPECTADOR) {
  ok(String(estado.enc).includes('AV1'), `o codificador único está em AV1 (${estado.enc})`);
  depois.forEach((d, i) => {
    const codec = d.codecs?.[d.codecId];
    ok(codec === 'video/AV1', `espectador ${i} recebe e decodifica AV1 (${codec})`);
  });
} else if (AV1) {
  ok(!String(estado.enc).includes('AV1'), `espectador sem decoder eficiente segura a sala em H.264 (${estado.enc})`);
  depois.forEach((d, i) => {
    const codec = d.codecs?.[d.codecId];
    ok(codec === 'video/H264', `espectador ${i} recusou AV1 e recebe H.264 (${codec})`);
  });
}
if (!AV1_ESPECTADOR) {
  // O piso da sala (ADR 0016): o espectador que recusa AV1 não pode reordenar a resposta para Baseline/VP8.
  ok(/H\.264 (Main|High)/.test(String(estado.enc)), `sala em H.264 Main/High, não Baseline (${estado.enc})`);
}
const chavesIsca = Math.max(...iscas.map((x) => x.chaves));
ok(iscas.every((x) => x.w <= 32), `os senders codificam só a isca (${iscas.map((x) => x.w).join(', ')} px)`);
ok(chavesIsca <= 3, `a isca não gera quadro-chave sozinha (${chavesIsca} no total)`);

await browser.close();
console.log(process.exitCode ? '\n=== UM-ENCODE FALHOU ===' : '\n=== UM-ENCODE PASSOU ===');
