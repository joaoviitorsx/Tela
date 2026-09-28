/**
 * Link estreito em navegador REAL (TELA-015).
 *
 * O simulador prova a malha com um modelo, incluindo o colapso numa conexão
 * viva (`--quedas`). Este prova o que dá para provar num Chrome headless sem
 * root: com o upload estreito desde a conexão, a `BroadcastSession` real não
 * fica anunciando 1080p60 num cano que não paga, e diz o motivo.
 *
 * Como: o transmissor é a `BroadcastSession` do produto, com um canvas de
 * ruído no lugar da captura de tela; o espectador é a página real. O upload
 * do transmissor é estrangulado por CDP (`Network.emulateNetworkConditions`,
 * que no Chromium também vale para WebRTC — medido: 7,8 → 0,66 Mbps).
 *
 *   pnpm dev          # num terminal
 *   node e2e/banda.e2e.mjs
 *
 * Leva ~2 minutos. Não substitui rede real com `tc netem`: CDP estrangula no
 * processo do navegador, não na placa.
 */
import { chromium } from 'playwright';

const CHROME =
  process.env.CHROME ?? '/home/joaoviitosx/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const SLUG = process.env.SLUG ?? 'banda';
const CONVITE = 'col' + 'c'.repeat(19);
const LIMITE_BPS = Number(process.env.LIMITE_BPS ?? 1_500_000);

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'],
});

const host = await (await browser.newContext()).newPage();
host.on('pageerror', (e) => console.log(`  [host] pageerror: ${e.message}`));
await host.goto(`${WEB}/?abertura=0`, { waitUntil: 'domcontentloaded' });

await host.evaluate(
  async ([slug, convite]) => {
    const { BroadcastSession } = await import('/src/core/media/broadcast-session.ts');
    const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
    const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
    const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
    const { makeBrowserAudioGain } = await import('/src/adapters/browser-audio-gain.ts');

    // Ruído colorido a 60 fps: o encoder sempre quer mais bits do que há.
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');
    let quadro = 0;
    setInterval(() => {
      quadro += 1;
      for (let i = 0; i < 400; i += 1) {
        ctx.fillStyle = `hsl(${(quadro * 7 + i * 13) % 360},80%,50%)`;
        ctx.fillRect(Math.random() * 1920, Math.random() * 1080, 90, 90);
      }
    }, 16);
    const video = canvas.captureStream(60).getVideoTracks()[0];

    const scheduler = makeBrowserScheduler();
    const session = new BroadcastSession({
      transport: makeMeshTransport({
        channel: makeWsSignaling(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`),
        scheduler,
      }),
      screen: {
        isSupported: () => true,
        request: async () => ({ ok: true, value: { video, audio: null, surface: 'monitor' } }),
      },
      audio: {
        requestPermission: async () => false,
        listMonitors: async () => [],
        capture: async () => {
          throw new Error('sem áudio no ensaio');
        },
      },
      gain: makeBrowserAudioGain(),
      scheduler,
      shareUrlFor: (s, k) => `${location.origin}/${s}#k=${k}`,
      convite: { atual: () => convite, renovar: () => convite },
      createStream: (tracks) => new MediaStream([...tracks]),
    });
    window.__sessao = session;
    await session.start(slug, 'k'.repeat(43), { presetId: 'p1080p60' });
  },
  [SLUG, CONVITE],
);

const estado = () =>
  host.evaluate(() => {
    const s = window.__sessao.getState();
    if (s.status !== 'live') return { status: s.status };
    return {
      status: s.status,
      preset: s.presetId,
      motivo: s.motivoDegradacao,
      limitacao: s.stats?.limitation ?? null,
      kbps: s.stats === null ? null : Math.round(s.stats.bitrateBps / 1000),
      largura: s.stats?.width ?? null,
      rtt: s.stats?.rttMs ?? null,
      bweKbps: s.stats?.piorAvailableBps == null ? null : Math.round(s.stats.piorAvailableBps / 1000),
    };
  });

console.log('\n1. Transmissor ao vivo com a BroadcastSession real');
ok((await estado()).status === 'live', 'sessão no ar');

/*
  O estrangulamento vem ANTES do espectador. Medido: o CDP só vale para
  conexões criadas depois dele — aplicado numa conexão viva (nos dois lados,
  no mesmo contexto ou não), o envio seguiu em 16 Mbps. Colapso numa conexão
  JÁ aberta não dá para reproduzir aqui; precisa de `tc netem` (root).
*/
const cdps = [];
for (const pagina of [host]) {
  const cdp = await pagina.context().newCDPSession(pagina);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 20,
    downloadThroughput: LIMITE_BPS / 8, uploadThroughput: LIMITE_BPS / 8,
  });
  cdps.push(cdp);
}
const viewer = await host.context().newPage();
await viewer.goto(`${WEB}/${SLUG}#k=${CONVITE}`, { waitUntil: 'domcontentloaded' });

console.log(`\n2. Link de ${(LIMITE_BPS / 1e6).toFixed(1)} Mbps desde a conexão: a sessão desce e diz por quê`);
const limitacoes = [];
let desceu = null;
for (let s = 0; s < 60; s += 5) {
  await esperar(5_000);
  const e = await estado();
  limitacoes.push(e.limitacao);
  console.log(`   t+${s + 5}s ${JSON.stringify(e)}`);
  if (desceu === null && e.preset !== undefined && e.preset !== 'p1080p60') desceu = s + 5;
}
const apertado = await estado();
ok(apertado.kbps !== null && apertado.kbps < (LIMITE_BPS / 1000) * 1.3, `envio cabe no link (${apertado.kbps} kbps)`);
ok(desceu !== null, `o degrau saiu de 1080p60 (em ~${desceu ?? '—'}s) — não fica anunciando o que o link não paga`);
ok(limitacoes.includes('bandwidth'), 'o Chrome real reporta `bandwidth` com o link estreito');

// Medido: TIRAR o limite vale na conexão viva (o BWE sobe), só pôr não vale.
console.log('\n3. O limite sai: a estimativa sobe e o degrau acompanha');
for (const cdp of cdps) {
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
}
let subiu = null;
for (let s = 0; s < 120; s += 10) {
  await esperar(10_000);
  const e = await estado();
  console.log(`   t+${s + 10}s ${JSON.stringify(e)}`);
  if (subiu === null && e.preset !== apertado.preset) subiu = s + 10;
  if (subiu !== null && s >= 60) break;
}
ok(subiu !== null, `o degrau voltou a subir com a rede livre (em ~${subiu ?? '—'}s)`);

await host.evaluate(() => window.__sessao.stop('USER_STOPPED'));
await browser.close();
console.log(process.exitCode ? '\n=== BANDA FALHOU ===' : '\n=== BANDA PASSOU ===');
