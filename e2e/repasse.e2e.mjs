/**
 * Cascata de repasse (ADR 0031, fase 1) em Chrome real.
 *
 * Anfitrião: a `BroadcastSession` de verdade sobre "um encode, N envios", com a
 * cascata forçada (em loopback a malha nunca aperta). Espectadores: a rota
 * `/<canal>` de produção, cada um num contexto próprio.
 *
 * Critérios:
 *   1. a árvore se forma: um espectador repassa e pelo menos um decodifica o
 *      vídeo que veio DELE (conexão sem áudio), com fluidez;
 *   2. o anfitrião para de mandar vídeo ao filho (um caminho de vídeo a menos);
 *   3. o repassador continua assistindo normalmente;
 *   4. o repassador some: o filho volta a decodificar pela conexão do
 *      anfitrião, sem recarregar a página.
 *
 *   pnpm dev                       (noutro terminal)
 *   node e2e/repasse.e2e.mjs
 */
import { chromium } from 'playwright';

const CHROME = process.env.CHROME ?? chromium.executablePath();
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const ESPECTADORES = Number(process.env.ESPECTADORES ?? 3);

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

async function pagina(rotulo) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(guardarPcs);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${rotulo}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.text().includes('[repasse')) console.log(`  [${rotulo}] ${m.text()}`);
  });
  return { ctx, p };
}

const slug = `rp${Math.random().toString(36).slice(2, 8)}`;
const { p: host } = await pagina('host');
await host.goto(`${WEB}/@@e2e`, { waitUntil: 'networkidle' });

console.log('\n1. Anfitrião no ar, "um encode", cascata forçada');
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
    ctx.fillStyle = `hsl(${(t * 3) % 360} 50% 30%)`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 40; i += 1) ctx.fillRect((t * 7 + i * 31) % W, (i * 17 + t * 3) % H, 40, 40);
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
      forcarRepasse: true,
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
  await session.start(canal, `e2e${'r'.repeat(40)}`, { presetId: 'p720p60' });
  return session.getState().status;
}, slug);
ok(subiu === 'live', `sessão no ar (${subiu})`);

const espectadores = [];
for (let i = 0; i < ESPECTADORES; i += 1) {
  const e = await pagina(`espectador${i}`);
  await e.p.goto(`${WEB}/${slug}`, { waitUntil: 'domcontentloaded' });
  espectadores.push(e);
}

/**
 * Por conexão: é a do anfitrião? (a primeira que o espectador abre sempre é),
 * quadros decodificados, bytes de vídeo enviados. Indexado pela ordem de
 * criação, para comparar duas leituras conexão a conexão.
 */
const lerConexoes = (p) => p.evaluate(async () => {
  const out = [];
  for (const [i, pc] of (window.__pcs ?? []).entries()) {
    const c = { anfitriao: i === 0, viva: pc.connectionState === 'connected', dec: 0, w: 0, cong: 0, enviado: 0, jbD: 0, jbN: 0, jbT: 0 };
    out.push(c);
    if (!c.viva) continue;
    (await pc.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        c.dec = s.framesDecoded ?? 0;
        c.w = s.frameWidth ?? 0;
        c.cong = s.freezeCount ?? 0;
        c.jbD = s.jitterBufferDelay ?? 0;
        c.jbN = s.jitterBufferEmittedCount ?? 0;
        c.jbT = s.jitterBufferTargetDelay ?? 0;
        c.pli = s.pliCount ?? 0;
        c.perdas = s.packetsLost ?? 0;
        c.desc = s.framesDropped ?? 0;
        c.rec = s.framesReceived ?? 0;
        c.chaves = s.keyFramesDecoded ?? 0;
      }
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        c.enviado += s.bytesSent ?? 0;
        c.enc = s.framesEncoded ?? 0;
        c.env = s.framesSent ?? 0;
        c.lim = s.qualityLimitationReason;
        c.fpsSaida = s.framesPerSecond;
      }
    });
  }
  return out;
});

/** Espera até `cond` valer, lendo a cada segundo. */
async function ate(cond, prazoMs) {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) {
    if (await cond()) return true;
    await esperar(1000);
  }
  return false;
}

/** O vídeo decodificado em cada espectador, por origem, ao longo de `ms`. */
async function medir(ms) {
  const antes = await Promise.all(espectadores.map((e) => lerConexoes(e.p)));
  await esperar(ms);
  const depois = await Promise.all(espectadores.map((e) => lerConexoes(e.p)));
  return depois.map((d, i) =>
    d.map((c, j) => {
      const a = antes[i][j] ?? { dec: 0, enviado: 0, cong: 0 };
      return {
        ...c,
        fps: (c.dec - a.dec) / (ms / 1000),
        kbpsEnviado: ((c.enviado - a.enviado) * 8) / ms,
        congelou: c.cong - a.cong,
        diag: `pli ${(c.pli ?? 0) - (a.pli ?? 0)}, perdas ${(c.perdas ?? 0) - (a.perdas ?? 0)}, rec ${(((c.rec ?? 0) - (a.rec ?? 0)) / (ms / 1000)).toFixed(1)}/s, desc ${(c.desc ?? 0) - (a.desc ?? 0)}, chaves ${(c.chaves ?? 0) - (a.chaves ?? 0)}`,
        encFps: ((c.enc ?? 0) - (a.enc ?? 0)) / (ms / 1000),
        envFps: ((c.env ?? 0) - (a.env ?? 0)) / (ms / 1000),
        jbMs: c.jbN > (a.jbN ?? 0) ? ((c.jbD - (a.jbD ?? 0)) / (c.jbN - a.jbN)) * 1000 : null,
        jbAlvoMs: c.jbN > (a.jbN ?? 0) ? ((c.jbT - (a.jbT ?? 0)) / (c.jbN - a.jbN)) * 1000 : null,
      };
    }),
  );
}

console.log('\n2. A árvore se forma (estado a cada 5 s, tique a cada 2 s, assentar 5 s)');
let papeis = null;
const formou = await ate(async () => {
  const m = await medir(2000);
  // Filho: decodifica vídeo numa conexão que não é a do anfitrião.
  const filhos = m.map((cs, i) => (cs.some((c) => !c.anfitriao && c.fps > 5) ? i : -1)).filter((i) => i >= 0);
  // Repassador: manda vídeo (bytes de verdade) por alguma conexão.
  const repassadores = m.map((cs, i) => (cs.some((c) => c.kbpsEnviado > 200) ? i : -1)).filter((i) => i >= 0);
  if (filhos.length > 0 && repassadores.length > 0) {
    papeis = { filhos, repassadores };
    return true;
  }
  return false;
}, 60_000);
ok(formou, `um espectador repassa e outro recebe dele (${JSON.stringify(papeis)})`);
if (!formou) {
  await browser.close();
  console.log('\n=== REPASSE FALHOU ===');
  process.exit(1);
}

console.log('\n3. 15 s de medição com a árvore assentada');
// O repassador ganha uma vaga a cada ~10 s de folga: espera o 2º filho entrar
// e assentar, para a janela não pegar ninguém no meio da troca.
await esperar(25_000);
const m = await medir(15_000);
const hostAntes = await host.evaluate(async () => {
  const out = [];
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState !== 'connected') continue;
    let b = 0;
    (await pc.getStats()).forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') b += s.bytesSent ?? 0;
    });
    out.push(b);
  }
  return out;
});
await esperar(3000);
const hostDepois = await host.evaluate(async () => {
  const out = [];
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState !== 'connected') continue;
    let b = 0;
    (await pc.getStats()).forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') b += s.bytesSent ?? 0;
    });
    out.push(b);
  }
  return out;
});
const caminhosAtivos = hostDepois.filter((b, i) => b - (hostAntes[i] ?? 0) > 10_000).length;

m.forEach((cs, i) => {
  const desc = cs.filter((c) => c.viva).map((c) => `${c.anfitriao ? 'anfitrião' : 'par'}: ${c.fps.toFixed(1)} fps, ${c.w}px, envia ${c.kbpsEnviado.toFixed(0)} kbps, ${c.congelou} cong., jb ${c.jbMs?.toFixed(0) ?? '-'} ms (alvo ${c.jbAlvoMs?.toFixed(0) ?? '-'})${c.kbpsEnviado > 0 ? `, isca ${c.encFps.toFixed(0)} cod/${c.envFps.toFixed(0)} env por s, lim ${c.lim}` : ''}${c.fps > 0 ? ` [${c.diag}]` : ''}`).join(' | ');
  console.log(`   espectador ${i}: ${desc}`);
});
const filhos = m.map((cs, i) => ({ i, c: cs.find((c) => !c.anfitriao && c.fps > 0) })).filter((x) => x.c !== undefined);
ok(filhos.length >= 1, `${filhos.length} filho(s) recebendo do repassador`);
for (const { i, c } of filhos) {
  ok(c.fps >= 20, `filho ${i} decodifica com fluidez pelo repassador (${c.fps.toFixed(1)} fps; a fonte é 30)`);
  ok(c.w >= 640, `filho ${i} recebe a imagem de verdade, não a isca (${c.w}px)`);
  ok(c.congelou === 0, `filho ${i} sem congelamento (${c.congelou})`);
}
for (const i of papeis.repassadores) {
  const fps = m[i].find((c) => c.anfitriao)?.fps ?? 0;
  ok(fps >= 20, `repassador ${i} continua assistindo pelo anfitrião (${fps.toFixed(1)} fps)`);
}
ok(
  caminhosAtivos === ESPECTADORES - filhos.length,
  `o anfitrião manda vídeo só a quem não é filho (${caminhosAtivos} caminho(s) de vídeo para ${ESPECTADORES} espectadores)`,
);

// O HUD de latência do filho soma o atraso que o pai informa ao do salto: tem
// de ficar perto do pai e nunca abaixo dele (um salto não tira atraso).
const lerHud = (p) => p.evaluate(() => {
  const el = [...document.querySelectorAll('[title]')].find((e) => /captura até a tela|só a recepção/.test(e.getAttribute('title') ?? ''));
  if (!el) return null;
  const ms = Number(/(\d+)\s*ms/.exec(el.textContent ?? '')?.[1] ?? NaN);
  return { captura: /captura até a tela/.test(el.getAttribute('title') ?? ''), ms };
});
const hudPai = await lerHud(espectadores[papeis.repassadores[0]].p);
for (const { i } of filhos) {
  const hud = await lerHud(espectadores[i].p);
  console.log(`   HUD: repassador ${JSON.stringify(hudPai)} · filho ${i} ${JSON.stringify(hud)}`);
  ok(hud?.captura === true, `HUD do filho ${i} mede captura até a tela (não esconde o salto)`);
  if (hud?.captura === true && hudPai?.captura === true) {
    ok(
      hud.ms >= hudPai.ms - 5 && hud.ms <= hudPai.ms + 40,
      `latência do filho ${i} (${hud.ms} ms) = a do pai (${hudPai.ms} ms) + um salto de no máximo 40 ms`,
    );
  }
}

console.log('\n4. O repassador sai: o filho volta ao anfitrião');
const repassador = papeis.repassadores[0];
const filhoIdx = filhos[0].i;
await espectadores[repassador].ctx.close();
// Antes de fechar: quantos quadros o filho já decodificou pelo anfitrião.
const base = (await lerConexoes(espectadores[filhoIdx].p))[0]?.dec ?? 0;
const saiuEm = Date.now();
let voltou = false;
while (Date.now() - saiuEm < 20_000) {
  const d = await lerConexoes(espectadores[filhoIdx].p);
  if ((d[0]?.dec ?? 0) - base >= 3) {
    voltou = true;
    break;
  }
  await esperar(100);
}
const volta = (Date.now() - saiuEm) / 1000;
console.log(`   imagem do anfitrião de volta em ${volta.toFixed(1)} s`);
ok(volta <= 2.5, `a volta ao anfitrião leva no máximo 2,5 s (${volta.toFixed(1)} s)`);
ok(voltou, `filho ${filhoIdx} decodifica de novo pela conexão do anfitrião`);
const estado = await espectadores[filhoIdx].p.evaluate(() => document.body.innerText.slice(0, 200));
ok(!/caiu|encerr|erro/i.test(estado), 'a página do filho continua assistindo, sem tela de erro');

await browser.close();
console.log(process.exitCode ? '\n=== REPASSE FALHOU ===' : '\n=== REPASSE PASSOU ===');
