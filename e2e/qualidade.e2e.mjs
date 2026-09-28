/**
 * Harness de QUALIDADE — mede, não deduz.
 *
 * Diferente de `mesh.e2e.mjs`, que prova que a malha CONECTA, este arquivo
 * existe para responder oito perguntas numéricas sobre o pipeline de vídeo,
 * cada uma com um número saído de um `getStats()` real:
 *
 *   1. Que codecs o Chromium desta máquina realmente oferece.
 *   2. O que foi NEGOCIADO (codec, profile-level-id, packetization-mode).
 *   3. Se o munging de SDP de `sdp-tuning.ts` chegou à descrição aplicada.
 *   4. Se `scaleResolutionDownBy` tira PIXEL de verdade ao trocar de degrau.
 *   5. Se a malha do orçamento (governador + topologia) ABRE ou trava.
 *   6. Bits por pixel medidos ao longo do tempo.
 *   7. `encoderImplementation` exato.
 *   8. Se os parâmetros dos senders são idênticos com 2 e com 3 espectadores.
 *
 * O transmissor NÃO roda a UI: a rota `/src/main.tsx` é bloqueada e os módulos
 * são importados à mão. Isso é deliberado — a abertura 3D e a vitrine WebGL
 * rodam num loop de render contínuo e roubariam CPU do encoder, contaminando
 * exatamente o número que este arquivo existe para medir. Os espectadores
 * rodam o app inteiro, de verdade.
 *
 * A captura é um canvas 1920x1080 com ruído em tela cheia mais 420 partículas:
 * conteúdo estático comprime a nada e esconderia toda a medição.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

// Chromium do Playwright por padrão; `CHROME=/caminho` usa outro navegador.
const CHROME = process.env.CHROME ?? chromium.executablePath();
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const SLUG = process.env.SLUG ?? 'qualidade';
// Protocolo v2 (TELA-018): a sala só abre com o convite do link.
const CONVITE = 'q2e' + 'c'.repeat(19);
const SAIDA = process.env.SAIDA ?? join(tmpdir(), 'qualidade-e2e.json');

/** Dureza do conteúdo. Ver o bloco em `fonteAnimada`. */
const FONTE = {
  tile: Number(process.env.RUIDO_TILE ?? 240),
  alpha: Number(process.env.RUIDO_ALPHA ?? 0.06),
  particulas: Number(process.env.PARTICULAS ?? 200),
  pan: Number(process.env.PAN ?? 1),
  // Giro/zoom forçam reamostragem bilinear do mundo inteiro a cada quadro, e
  // em raster por software isso derruba a fonte de 58 para 43 fps — CPU que o
  // encoder precisa. Pan puro já é movimento global de tela cheia.
  giro: Number(process.env.GIRO ?? 0),
};
/** `CALIBRA=1` roda só o transmissor + um espectador, segurando 1080p60. */
const CALIBRA = process.env.CALIBRA === '1';

const relatorio = {
  ambiente: { chrome: CHROME, web: WEB, slug: SLUG, quando: new Date().toISOString() },
};

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, casas = 2) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(casas) : String(n);
const mbps = (bps) => (typeof bps === 'number' && Number.isFinite(bps) ? bps / 1e6 : null);

function estatisticas(valores) {
  const v = valores.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, min: null, mediana: null, max: null, media: null };
  const meio = Math.floor(v.length / 2);
  return {
    n: v.length,
    min: v[0],
    mediana: v.length % 2 ? v[meio] : (v[meio - 1] + v[meio]) / 2,
    max: v[v.length - 1],
    media: v.reduce((a, b) => a + b, 0) / v.length,
  };
}

/* ------------------------------------------------------------------ */
/* Instrumentação injetada ANTES de qualquer script da página.         */
/* ------------------------------------------------------------------ */

function instrumentar() {
  const Orig = window.RTCPeerConnection;
  window.__pcs = [];
  window.__remoteSdp = [];
  window.__localSdp = [];
  window.__codecPrefs = [];

  const srd = Orig.prototype.setRemoteDescription;
  Orig.prototype.setRemoteDescription = function (desc, ...rest) {
    let usado = desc;
    try {
      window.__remoteSdp.push({ t: Date.now(), type: desc?.type ?? null, sdp: desc?.sdp ?? null });
      /**
       * Braço de CONTROLE do A/B.
       *
       * `sdp-tuning.ts` escreve `x-google-start-bitrate` na descrição remota, e
       * ver a string aplicada só prova que ela chegou — não que ela MUDE
       * alguma coisa. Aqui o harness a remove logo depois, sem tocar em uma
       * linha de produto, e a mesma rampa é medida de novo. A diferença entre
       * os dois braços é o efeito real do munging.
       */
      if (window.__semStartBitrate === true && typeof desc?.sdp === 'string') {
        usado = {
          type: desc.type,
          sdp: desc.sdp.replace(/;?x-google-start-bitrate=\d+/g, ''),
        };
        window.__stripou = (window.__stripou ?? 0) + 1;
      }
    } catch {
      /* nada */
    }
    return srd.call(this, usado, ...rest);
  };

  const sld = Orig.prototype.setLocalDescription;
  Orig.prototype.setLocalDescription = function (...args) {
    const pc = this;
    const p = sld.apply(this, args);
    p.then(
      () => {
        try {
          window.__localSdp.push({
            t: Date.now(),
            type: pc.localDescription?.type ?? null,
            sdp: pc.localDescription?.sdp ?? null,
          });
        } catch {
          /* nada */
        }
      },
      () => {},
    );
    return p;
  };

  if (window.RTCRtpTransceiver?.prototype?.setCodecPreferences) {
    const scp = window.RTCRtpTransceiver.prototype.setCodecPreferences;
    window.RTCRtpTransceiver.prototype.setCodecPreferences = function (codecs) {
      try {
        window.__codecPrefs.push(
          [...(codecs ?? [])].map((c) => ({
            mimeType: c.mimeType,
            sdpFmtpLine: c.sdpFmtpLine ?? null,
          })),
        );
      } catch {
        /* nada */
      }
      return scp.call(this, codecs);
    };
  }

  window.RTCPeerConnection = class extends Orig {
    constructor(...args) {
      super(...args);
      window.__pcs.push(this);
    }
  };

  /** Capacidades cruas, exatamente como o navegador anuncia. */
  window.__capacidades = () => {
    const s = window.RTCRtpSender.getCapabilities?.('video') ?? null;
    const r = window.RTCRtpReceiver.getCapabilities?.('video') ?? null;
    const mapa = (c) =>
      c === null
        ? null
        : c.codecs.map((x) => ({
            mimeType: x.mimeType,
            clockRate: x.clockRate,
            sdpFmtpLine: x.sdpFmtpLine ?? null,
          }));
    return { sender: mapa(s), receiver: mapa(r) };
  };

  /** Uma amostra de `getStats()` por conexão viva. */
  window.__amostra = async () => {
    const vivas = window.__pcs.filter(
      (pc) => pc.connectionState !== 'closed' && pc.connectionState !== 'failed',
    );
    const saida = [];
    for (let i = 0; i < vivas.length; i += 1) {
      const pc = vivas[i];
      let report;
      try {
        report = await pc.getStats();
      } catch {
        continue;
      }
      const codecs = new Map();
      let outbound = null;
      let par = null;
      report.forEach((s) => {
        if (s.type === 'codec') codecs.set(s.id, s);
        if (s.type === 'outbound-rtp' && s.kind === 'video') {
          outbound = s;
        }
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated !== false) {
          if (par === null || (s.availableOutgoingBitrate ?? 0) > (par.availableOutgoingBitrate ?? 0)) {
            par = s;
          }
        }
      });
      const codec = outbound?.codecId ? (codecs.get(outbound.codecId) ?? null) : null;
      saida.push({
        idx: i,
        connectionState: pc.connectionState,
        outbound:
          outbound === null
            ? null
            : {
                ssrc: outbound.ssrc ?? null,
                timestamp: outbound.timestamp,
                bytesSent: outbound.bytesSent ?? 0,
                frameWidth: outbound.frameWidth ?? null,
                frameHeight: outbound.frameHeight ?? null,
                framesPerSecond: outbound.framesPerSecond ?? null,
                framesEncoded: outbound.framesEncoded ?? null,
                framesSent: outbound.framesSent ?? null,
                keyFramesEncoded: outbound.keyFramesEncoded ?? null,
                qpSum: outbound.qpSum ?? null,
                totalEncodeTime: outbound.totalEncodeTime ?? null,
                qualityLimitationResolutionChanges:
                  outbound.qualityLimitationResolutionChanges ?? null,
                targetBitrate: outbound.targetBitrate ?? null,
                encoderImplementation: outbound.encoderImplementation ?? null,
                powerEfficientEncoder: outbound.powerEfficientEncoder ?? null,
                qualityLimitationReason: outbound.qualityLimitationReason ?? null,
                qualityLimitationDurations: outbound.qualityLimitationDurations ?? null,
                scalabilityMode: outbound.scalabilityMode ?? null,
                active: outbound.active ?? null,
                rid: outbound.rid ?? null,
              },
        codec:
          codec === null
            ? null
            : {
                mimeType: codec.mimeType ?? null,
                payloadType: codec.payloadType ?? null,
                sdpFmtpLine: codec.sdpFmtpLine ?? null,
                clockRate: codec.clockRate ?? null,
              },
        par:
          par === null
            ? null
            : {
                availableOutgoingBitrate: par.availableOutgoingBitrate ?? null,
                currentRoundTripTime: par.currentRoundTripTime ?? null,
                nominated: par.nominated ?? null,
                bytesSent: par.bytesSent ?? null,
              },
      });
    }
    return saida;
  };

  /** Relatório INTEIRO, sem filtro: é onde se descobre o que o navegador omite. */
  window.__cruTudo = async () => {
    const pc = window.__pcs.find((p) => p.connectionState === 'connected');
    if (pc === undefined) return null;
    const report = await pc.getStats();
    const saida = [];
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' || s.type === 'media-source' || s.type === 'codec') {
        saida.push(JSON.parse(JSON.stringify(s)));
      }
    });
    return saida;
  };

  /** `getParameters()` de todo sender vivo, sem passar pelo transporte. */
  window.__params = () =>
    window.__pcs
      .filter((pc) => pc.connectionState !== 'closed' && pc.connectionState !== 'failed')
      .map((pc, i) => ({
        idx: i,
        connectionState: pc.connectionState,
        senders: pc
          .getSenders()
          .filter((s) => s.track !== null)
          .map((s) => {
            let p;
            try {
              p = s.getParameters();
            } catch {
              return { kind: s.track?.kind ?? null, erro: 'getParameters lançou' };
            }
            return {
              kind: s.track.kind,
              trackSettings: s.track.getSettings?.() ?? null,
              degradationPreference: p.degradationPreference ?? null,
              encodings: (p.encodings ?? []).map((e) => ({
                active: e.active ?? null,
                maxBitrate: e.maxBitrate ?? null,
                maxFramerate: e.maxFramerate ?? null,
                scaleResolutionDownBy: e.scaleResolutionDownBy ?? null,
                networkPriority: e.networkPriority ?? null,
                priority: e.priority ?? null,
                rid: e.rid ?? null,
              })),
              codecs: (p.codecs ?? []).map((c) => `${c.mimeType} ${c.sdpFmtpLine ?? ''}`.trim()),
            };
          }),
      }));
}

/* ------------------------------------------------------------------ */
/* Fonte de vídeo: 1920x1080 com ruído em tela cheia + partículas.     */
/* ------------------------------------------------------------------ */

function fonteAnimada(w, h, opcoes) {
  const {
    alpha: ALPHA = 0.06,
    particulas: NPART = 260,
    tile: NLADO = 240,
    giro: GIRO = 1,
    pan: PAN = 1,
  } = opcoes ?? {};

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  /**
   * O conteúdo precisa ser DIFÍCIL como gameplay é difícil, não como ruído é.
   *
   * A primeira versão jogava ruído por pixel em tela cheia com 60% de
   * opacidade. Medido: o QP nunca desceu de 37, o *quality scaler* do Chromium
   * derrubou 1920x1080 até 213x120 sozinho, e a medição de
   * `scaleResolutionDownBy` — a razão de este arquivo existir — ficou
   * indistinguível da atuação do navegador. Ruído puro não pede 0,20 bit por
   * pixel; pede infinito, e nenhum orçamento o satisfaz.
   *
   * Gameplay é outra coisa: MUITO movimento sobre um mundo com estrutura. Um
   * flick de mira desloca a tela inteira, e é caro justamente porque os vetores
   * de movimento têm de trabalhar — não porque o quadro seja aleatório.
   *
   * Então: um mundo detalhado desenhado uma vez, deslocado e girado a cada
   * quadro (a câmera), partículas rápidas por cima (os efeitos) e uma pitada de
   * grão para que a predição nunca seja perfeita.
   */
  const MW = 3600;
  const MH = 2400;
  const mundo = document.createElement('canvas');
  mundo.width = MW;
  mundo.height = MH;
  const mctx = mundo.getContext('2d', { alpha: false });
  mctx.fillStyle = '#0d1016';
  mctx.fillRect(0, 0, MW, MH);
  for (let i = 0; i < 4200; i += 1) {
    const x = Math.random() * MW;
    const y = Math.random() * MH;
    const s = 6 + Math.random() * 90;
    mctx.fillStyle = `hsl(${Math.random() * 360} ${40 + Math.random() * 55}% ${12 + Math.random() * 60}%)`;
    if (i % 3 === 0) {
      mctx.fillRect(x, y, s, s * (0.2 + Math.random()));
    } else if (i % 3 === 1) {
      mctx.beginPath();
      mctx.arc(x, y, s / 2, 0, Math.PI * 2);
      mctx.fill();
    } else {
      mctx.beginPath();
      mctx.moveTo(x, y);
      mctx.lineTo(x + s, y + s / 2);
      mctx.lineTo(x - s / 3, y + s);
      mctx.closePath();
      mctx.fill();
    }
  }
  // Texto: alta frequência espacial, o que mais castiga o encoder em cena real.
  mctx.font = 'bold 26px monospace';
  for (let i = 0; i < 900; i += 1) {
    mctx.fillStyle = `hsl(${Math.random() * 360} 90% 75%)`;
    mctx.fillText(
      Math.random().toString(36).slice(2, 10),
      Math.random() * MW,
      Math.random() * MH,
    );
  }

  // Grão fino por cima, para que nenhum bloco seja perfeitamente previsível.
  const NW = NLADO;
  const NH = Math.round((NLADO * h) / w);
  const tile = document.createElement('canvas');
  tile.width = NW;
  tile.height = NH;
  const tctx = tile.getContext('2d', { alpha: false });
  const img = tctx.createImageData(NW, NH);
  const buf = new Uint32Array(img.data.buffer);

  const particulas = Array.from({ length: NPART }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 1400,
    vy: (Math.random() - 0.5) * 1400,
    r: 6 + Math.random() * 34,
    tom: Math.random() * 360,
  }));

  let semente = 0x9e3779b9;
  const rnd = () => (semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0);

  let quadros = 0;
  let t0 = performance.now();
  let anterior = t0;
  window.__fonte = { fps: 0, quadros: 0 };

  const desenhar = (agora) => {
    const dt = Math.min(0.05, (agora - anterior) / 1000);
    anterior = agora;
    const t = agora / 1000;

    // A "câmera": varre o mundo em oito, com giro. Deslocamento grande por
    // quadro é exatamente o flick de mira.
    const cx = (MW - w) / 2 + Math.sin(t * 0.9) * (MW - w) * 0.48 * PAN;
    const cy = (MH - h) / 2 + Math.sin(t * 1.7) * (MH - h) * 0.48 * PAN;
    if (GIRO > 0) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(Math.sin(t * 0.6) * 0.06 * GIRO);
      ctx.scale(1.06 + Math.sin(t * 0.4) * 0.05, 1.06 + Math.sin(t * 0.4) * 0.05);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(mundo, cx, cy, w, h, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(mundo, cx, cy, w, h, 0, 0, w, h);
    }

    // Partículas rápidas: os efeitos por cima da cena.
    for (const p of particulas) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < 0 || p.x > w) p.vx = -p.vx;
      if (p.y < 0 || p.y > h) p.vy = -p.vy;
      ctx.fillStyle = `hsl(${(p.tom + t * 120) % 360} 100% 60%)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (ALPHA > 0) {
      for (let i = 0; i < buf.length; i += 1) buf[i] = (rnd() & 0x00ffffff) | 0xff000000;
      tctx.putImageData(img, 0, 0);
      ctx.globalAlpha = ALPHA;
      ctx.drawImage(tile, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    quadros += 1;
    const passado = (agora - t0) / 1000;
    if (passado >= 1) {
      window.__fonte = { fps: quadros / passado, quadros };
      quadros = 0;
      t0 = agora;
    }
    requestAnimationFrame(desenhar);
  };
  requestAnimationFrame(desenhar);
  return canvas;
}

/* ------------------------------------------------------------------ */

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-running-insecure-content',
    '--disable-web-security',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ],
});

// Sem isto, um throw no meio da medição deixa um Chromium órfão segurando
// portas e CPU — e a próxima rodada mede o lixo da anterior.
const encerrarComErro = (erro) => {
  console.error('\n=== HARNESS ABORTOU ===');
  console.error(erro);
  browser
    .close()
    .catch(() => {})
    .finally(() => process.exit(1));
};
process.on('uncaughtException', encerrarComErro);
process.on('unhandledRejection', encerrarComErro);

const paginas = [];
async function novaPagina(rotulo, { semApp = false } = {}) {
  const ctx = await browser.newContext({ permissions: [], viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${rotulo}] console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [${rotulo}] pageerror: ${e.message}`));
  await page.addInitScript({
    content: `window.__semStartBitrate = ${process.env.SEM_START_BITRATE === '1'};`,
  });
  await page.addInitScript(instrumentar);
  // Aprovação manual (ADR 0025): espectador já com apelido, sem formulário.
  await page.addInitScript((apelido) => localStorage.setItem('tela.apelido', apelido), rotulo);
  await page.addInitScript({ content: `window.__criarFonte = ${fonteAnimada.toString()};` });
  if (semApp) {
    // A UI inteira fica de fora: só o servidor de módulos do Vite interessa.
    await page.route('**/src/main.tsx', (r) =>
      r.fulfill({ status: 200, contentType: 'text/javascript', body: 'export {};' }),
    );
  }
  paginas.push(page);
  return page;
}

console.log('\n=== HARNESS DE QUALIDADE ===');
console.log(`chrome: ${CHROME}`);

const host = await novaPagina('host', { semApp: true });
await host.goto(WEB, { waitUntil: 'domcontentloaded' });

/* ---- 1. Codecs disponíveis de verdade ----------------------------- */
console.log('\n[1] Capacidades de codec do RTCRtpSender');
const capacidades = await host.evaluate(() => window.__capacidades());
relatorio.capacidades = capacidades;
for (const c of capacidades.sender ?? []) {
  console.log(`   ${c.mimeType.padEnd(14)} ${c.clockRate}  ${c.sdpFmtpLine ?? ''}`);
}
const h264 = (capacidades.sender ?? []).filter((c) => c.mimeType.toLowerCase() === 'video/h264');
console.log(`   -> ${h264.length} variantes de H.264 no SENDER`);

/* ---- Sobe o transmissor ------------------------------------------- */
console.log('\n[setup] transmissor publica canvas 1920x1080 animado');
const subiu = await host.evaluate(
  async ([slug, fonte, convite]) => {
    const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
    const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
    const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
    const shared = await import('/node_modules/@tela/shared/dist/index.js');
    window.__shared = shared;

    const canvas = window.__criarFonte(1920, 1080, fonte);

    const stream = canvas.captureStream(60);
    const track = stream.getVideoTracks()[0];
    track.contentHint = shared.CONTENT_HINT;
    window.__track = track;

    const transport = makeMeshTransport({
      channel: makeWsSignaling(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`,
      ),
      // Obrigatório desde a TELA-005: é quem agenda a renovação do ICE.
      scheduler: makeBrowserScheduler(),
    });
    window.__transport = transport;
    await transport.host(slug, 'q'.repeat(43), convite);
    // Este harness mede qualidade, não aprovação (ADR 0025): aceita todo pedido.
    transport.on('pedido', (p) => transport.responderPedido(p.peerId, true));
    await transport.publishVideo(track, shared.PRESET_1080P60);

    /**
     * Rampa de arranque, a 5 Hz desde o primeiro pacote.
     *
     * `x-google-start-bitrate` só se manifesta no PRIMEIRO segundo: ele diz por
     * onde o controle de congestionamento começa em vez dos 300 kbps padrão.
     * Uma amostra por segundo, tirada cinco segundos depois, já perdeu o
     * evento — e é essa perda que faz o munging parecer inócuo.
     */
    window.__rampa = [];
    window.__rampaId = setInterval(async () => {
      const pc = window.__pcs.find((p) => p.connectionState === 'connected');
      if (pc === undefined) return;
      let report;
      try {
        report = await pc.getStats();
      } catch {
        return;
      }
      let o = null;
      let par = null;
      report.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') o = s;
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated !== false) par = s;
      });
      if (o === null) return;
      window.__rampa.push({
        t: Math.round(performance.now()),
        target: o.targetBitrate ?? null,
        bytes: o.bytesSent ?? 0,
        w: o.frameWidth ?? null,
        h: o.frameHeight ?? null,
        fps: o.framesPerSecond ?? null,
        avail: par?.availableOutgoingBitrate ?? null,
      });
    }, 200);

    return {
      settings: track.getSettings(),
      contentHint: track.contentHint,
      presets: Object.keys(shared.PRESETS),
    };
  },
  [SLUG, FONTE, CONVITE],
);
console.log(`   trilha: ${JSON.stringify(subiu.settings)} hint=${subiu.contentHint}`);
console.log(`   fonte: ${JSON.stringify(FONTE)}`);
relatorio.trilha = { ...subiu, fonte: FONTE };

/* ---- Espectador 1 -------------------------------------------------- */
const viewer1 = await novaPagina('viewer1');
await viewer1.goto(`${WEB}/${SLUG}#k=${CONVITE}`, { waitUntil: 'domcontentloaded' });

async function esperarFrames(page, segundos = 30) {
  for (let i = 0; i < segundos; i += 1) {
    const ok = await page
      .evaluate(() => {
        const v = document.querySelector('video');
        return Boolean(v && v.srcObject && v.videoWidth > 0);
      })
      .catch(() => false);
    if (ok) return true;
    await esperar(1000);
  }
  return false;
}
const conectou1 = await esperarFrames(viewer1);
console.log(`   espectador 1 recebendo frames: ${conectou1}`);
if (!conectou1) {
  console.log('   ABORTA: sem conexão não há o que medir.');
  await browser.close();
  process.exit(1);
}
await esperar(6000); // deixa o encoder e o BWE assentarem

/* ---- 2 e 3. SDP negociado e munging -------------------------------- */
console.log('\n[2/3] SDP negociado e munging de entrada');
const sdps = await host.evaluate(() => ({
  remote: window.__remoteSdp,
  local: window.__localSdp,
  prefs: window.__codecPrefs,
}));

function secaoVideo(sdp) {
  if (typeof sdp !== 'string') return null;
  const i = sdp.indexOf('m=video');
  if (i === -1) return null;
  const resto = sdp.slice(i);
  const j = resto.indexOf('\nm=', 1);
  return j === -1 ? resto : resto.slice(0, j);
}

function analisarVideo(sdp) {
  const sec = secaoVideo(sdp);
  if (sec === null) return null;
  const linhaM = sec.split(/\r?\n/)[0];
  const pts = linhaM.split(' ').slice(3);
  const rtpmap = new Map();
  const fmtp = new Map();
  for (const linha of sec.split(/\r?\n/)) {
    const r = /^a=rtpmap:(\d+) ([^/]+)\//.exec(linha);
    if (r) rtpmap.set(r[1], r[2]);
    const f = /^a=fmtp:(\d+) (.*)$/.exec(linha);
    if (f) fmtp.set(f[1], f[2]);
  }
  return {
    linhaM,
    ordem: pts.map((pt) => ({ pt, codec: rtpmap.get(pt) ?? null, fmtp: fmtp.get(pt) ?? null })),
    primeiro: {
      pt: pts[0],
      codec: rtpmap.get(pts[0]) ?? null,
      fmtp: fmtp.get(pts[0]) ?? null,
    },
    temStartBitrate: /x-google-start-bitrate=(\d+)/.exec(sec)?.[1] ?? null,
    niveis: [...sec.matchAll(/profile-level-id=([0-9a-fA-F]{6})/g)].map((m) => m[1]),
  };
}

const ultimoLocal = sdps.local.at(-1)?.sdp ?? null;
const ultimoRemoto = sdps.remote.at(-1)?.sdp ?? null;
const anaLocal = analisarVideo(ultimoLocal);
const anaRemoto = analisarVideo(ultimoRemoto);

console.log(`   ofertas locais capturadas: ${sdps.local.length} | remotas: ${sdps.remote.length}`);
console.log(`   setCodecPreferences chamado ${sdps.prefs.length}x`);
if (sdps.prefs.length > 0) {
  console.log('   ordem pedida (5 primeiros):');
  for (const c of sdps.prefs[0].slice(0, 5)) {
    console.log(`      ${c.mimeType.padEnd(14)} ${c.sdpFmtpLine ?? ''}`);
  }
}
console.log(`   m=video LOCAL  : ${anaLocal?.linhaM ?? 'n/d'}`);
console.log(
  `   1o PT local    : ${anaLocal?.primeiro.pt} ${anaLocal?.primeiro.codec} ${anaLocal?.primeiro.fmtp ?? ''}`,
);
console.log(`   m=video REMOTO : ${anaRemoto?.linhaM ?? 'n/d'}`);
console.log(
  `   1o PT remoto   : ${anaRemoto?.primeiro.pt} ${anaRemoto?.primeiro.codec} ${anaRemoto?.primeiro.fmtp ?? ''}`,
);
console.log(`   x-google-start-bitrate no remoto aplicado: ${anaRemoto?.temStartBitrate ?? 'AUSENTE'}`);
console.log(
  `   níveis no remoto aplicado: ${[...new Set(anaRemoto?.niveis ?? [])].join(', ') || 'nenhum'}`,
);

relatorio.sdp = {
  chamadasSetCodecPreferences: sdps.prefs.length,
  ordemPedida: sdps.prefs[0] ?? null,
  local: anaLocal,
  remotoAplicado: anaRemoto,
  remotoBruto: ultimoRemoto,
  localBruto: ultimoLocal,
};

/* ---- 3b. O arranque: `x-google-start-bitrate` mudou alguma coisa? --- */
console.log('\n[3b] Rampa de arranque do encoder (5 Hz desde o primeiro pacote)');
const rampa = await host.evaluate(() => {
  clearInterval(window.__rampaId);
  return window.__rampa;
});
relatorio.rampa = rampa;
const t0Rampa = rampa[0]?.t ?? 0;
for (const p of rampa.slice(0, 24)) {
  console.log(
    `   +${String(p.t - t0Rampa).padStart(5)}ms  alvo=${fmt(mbps(p.target), 2)}Mbps` +
      `  available=${fmt(mbps(p.avail), 2)}  ${p.w}x${p.h}@${fmt(p.fps, 0)}`,
  );
}
const stripou = await host.evaluate(() => window.__stripou ?? 0);
relatorio.rampaControle = {
  semStartBitrate: process.env.SEM_START_BITRATE === '1',
  sdpsComStartBitrateRemovido: stripou,
  primeiroAlvo: rampa.find((p) => p.target > 0)?.target ?? null,
  primeiroAvailable: rampa.find((p) => p.avail > 0)?.avail ?? null,
  alvoEm2s: rampa.find((p) => p.t - t0Rampa >= 2000)?.target ?? null,
  alvoEm5s: rampa.find((p) => p.t - t0Rampa >= 5000)?.target ?? null,
};
console.log(
  `   braço: ${process.env.SEM_START_BITRATE === '1' ? `SEM x-google-start-bitrate (removido de ${stripou} SDP)` : 'COM x-google-start-bitrate'}` +
    ` | primeiro alvo > 0: ${fmt(mbps(relatorio.rampaControle.primeiroAlvo), 2)} Mbps` +
    ` | primeiro available: ${fmt(mbps(relatorio.rampaControle.primeiroAvailable), 2)} Mbps` +
    ` | o SDP recebido pedia ${anaRemoto?.temStartBitrate ?? '?'} kbps`,
);

/* ---- Codec de fato usado, pelo getStats ---------------------------- */
const amostraCodec = await host.evaluate(() => window.__amostra());
relatorio.codecEmUso = amostraCodec.map((a) => a.codec);
console.log(`   codec do outbound-rtp: ${JSON.stringify(amostraCodec[0]?.codec ?? null)}`);

/* ---- 7. encoderImplementation -------------------------------------- */
console.log('\n[7] encoderImplementation');
const impl = amostraCodec.map((a) => ({
  encoderImplementation: a.outbound?.encoderImplementation ?? null,
  powerEfficientEncoder: a.outbound?.powerEfficientEncoder ?? null,
  scalabilityMode: a.outbound?.scalabilityMode ?? null,
}));
relatorio.encoder = impl;
console.log(`   ${JSON.stringify(impl)}`);
const cruTudo = await host.evaluate(() => window.__cruTudo());
relatorio.outboundRtpCru = cruTudo;
const rtpCru = (cruTudo ?? []).find((s) => s.type === 'outbound-rtp');
const campos = Object.keys(rtpCru ?? {});
console.log(`   campos presentes no outbound-rtp: ${campos.join(', ')}`);
console.log(
  `   'encoderImplementation' está no relatório? ${campos.includes('encoderImplementation') ? 'SIM' : 'NÃO — o campo nem existe'}`,
);

/**
 * O campo some por PRIVACIDADE, não por bug — e vale provar isso.
 *
 * Desde o M118 o Chromium só expõe `encoderImplementation`,
 * `decoderImplementation` e `powerEfficientEncoder` para páginas que já têm
 * permissão de câmera ou microfone concedida: são vetores de impressão digital
 * de hardware. Uma página que só captura tela (ou um canvas, como aqui) não
 * ganha essa permissão, e o campo simplesmente não aparece.
 *
 * O experimento: pedir `getUserMedia` com o dispositivo falso, o que concede a
 * permissão de verdade, e reler o mesmo `getStats()`.
 */
console.log('\n[7b] O campo volta com permissão de câmera/microfone?');
const comPermissao = await host.evaluate(async () => {
  const ler = async () => {
    const tudo = await window.__cruTudo();
    const rtp = (tudo ?? []).find((x) => x.type === 'outbound-rtp');
    return {
      presente: Object.keys(rtp ?? {}).includes('encoderImplementation'),
      encoderImplementation: rtp?.encoderImplementation ?? null,
      powerEfficientEncoder: rtp?.powerEfficientEncoder ?? null,
    };
  };
  const antes = await ler();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (e) {
    return { antes, erro: String(e) };
  }
  await new Promise((r) => setTimeout(r, 2500));
  const durante = await ler();
  // A câmera falsa sai de cena: ela custa CPU e a medição que vem a seguir é
  // sobre o encoder. A permissão da ORIGEM continua concedida — o que muda é
  // só não haver captura ativa, e é essa a distinção que o teste isola.
  for (const t of stream.getTracks()) t.stop();
  await new Promise((r) => setTimeout(r, 1500));
  const depois = await ler();
  return { antes, durante, depois };
});
relatorio.encoderComPermissao = comPermissao;
console.log(`   antes  do getUserMedia: ${JSON.stringify(comPermissao?.antes)}`);
console.log(`   COM captura viva      : ${JSON.stringify(comPermissao?.durante)}`);
console.log(`   depois de track.stop(): ${JSON.stringify(comPermissao?.depois)}`);

/* ---- Modo calibração: segura 1080p60 e mostra o que o encoder faz --- */
if (CALIBRA) {
  console.log('\n[CALIBRA] 25s em p1080p60 — resolução, fps, QP e limitação');
  let ant = null;
  for (let s = 0; s < 25; s += 1) {
    await esperar(1000);
    const a = (await host.evaluate(() => window.__amostra()))[0];
    const o = a?.outbound;
    if (!o) continue;
    let br = null;
    if (ant) {
      const dT = (o.timestamp - ant.timestamp) / 1000;
      if (dT > 0) br = ((o.bytesSent - ant.bytesSent) * 8) / dT;
    }
    const qp =
      ant && o.framesEncoded > ant.framesEncoded
        ? (o.qpSum - ant.qpSum) / (o.framesEncoded - ant.framesEncoded)
        : null;
    const fonte = await host.evaluate(() => window.__fonte);
    console.log(
      `   t=${String(s).padStart(2)}s ${o.frameWidth}x${o.frameHeight}@${fmt(o.framesPerSecond, 0)}` +
        ` fonte=${fmt(fonte?.fps, 1)}fps  br=${fmt(mbps(br), 2)}Mbps alvo=${fmt(mbps(o.targetBitrate), 2)}` +
        ` QP=${fmt(qp, 1)} limit=${o.qualityLimitationReason} impl=${o.encoderImplementation}`,
    );
    ant = o;
  }
  await browser.close();
  console.log('\n=== FIM (calibração) ===');
  process.exit(0);
}

/* ---- 4 e 6. Degraus de preset: pixel e bits por pixel --------------- */
console.log('\n[4/6] Varredura de presets — resolução codificada e bits por pixel');
const ORDEM = ['p1080p60', 'p900p60', 'p720p60', 'p600p60', 'p480p60', 'p360p60'];
const ESPERADO = {
  p1080p60: [1920, 1080],
  p900p60: [1600, 900],
  p720p60: [1280, 720],
  p600p60: [1024, 576],
  p480p60: [854, 480],
  p360p60: [640, 360],
};
const SEGUNDOS_POR_DEGRAU = Number(process.env.SEG_DEGRAU ?? 9);

async function varrerPresets(rotulo) {
const varredura = [];
for (const id of ORDEM) {
  await host.evaluate(async (presetId) => {
    await window.__transport.setPreset(window.__shared.PRESETS[presetId]);
  }, id);

  const params = await host.evaluate(() => window.__params());
  const escala =
    params[0]?.senders?.find((s) => s.kind === 'video')?.encodings?.[0]?.scaleResolutionDownBy ??
    null;
  const maxBitrate =
    params[0]?.senders?.find((s) => s.kind === 'video')?.encodings?.[0]?.maxBitrate ?? null;

  const linhas = [];
  let anterior = null;
  for (let s = 0; s < SEGUNDOS_POR_DEGRAU; s += 1) {
    await esperar(1000);
    const a = (await host.evaluate(() => window.__amostra()))[0];
    const o = a?.outbound ?? null;
    if (o === null) continue;
    let bitrate = null;
    if (anterior !== null) {
      const dB = o.bytesSent - anterior.bytesSent;
      const dT = (o.timestamp - anterior.timestamp) / 1000;
      if (dT > 0) bitrate = (dB * 8) / dT;
    }
    const bpp =
      bitrate !== null && o.frameWidth && o.frameHeight && o.framesPerSecond
        ? bitrate / (o.frameWidth * o.frameHeight * o.framesPerSecond)
        : null;
    const nQuadros = anterior === null ? 0 : o.framesEncoded - anterior.framesEncoded;
    const qp = nQuadros > 0 ? (o.qpSum - anterior.qpSum) / nQuadros : null;
    // Custo de encode por quadro: é o que decide se 1080p60 em software cabe.
    const encodeMs =
      nQuadros > 0 ? ((o.totalEncodeTime - anterior.totalEncodeTime) * 1000) / nQuadros : null;
    linhas.push({
      encodeMs,
      resChanges: o.qualityLimitationResolutionChanges,
      s,
      w: o.frameWidth,
      h: o.frameHeight,
      // Quanto a captura de 1920 encolheu no TOTAL. Se bater com
      // `scaleResolutionDownBy`, a redução é toda nossa; se for maior, o
      // *quality scaler* do Chromium entrou por cima.
      reducaoTotal: o.frameWidth ? 1920 / o.frameWidth : null,
      fps: o.framesPerSecond,
      bitrate,
      bpp,
      qp,
      limit: o.qualityLimitationReason,
      alvo: o.targetBitrate,
    });
    anterior = o;
  }
  // Descarta os 3 primeiros segundos: o encoder ainda está reconfigurando.
  // Nunca descarta tudo — em degrau curto sobra pelo menos a última amostra.
  const estaveis = linhas.slice(Math.min(3, Math.max(0, linhas.length - 1)));
  const fonteFps = await host.evaluate(() => window.__fonte);
  const item = {
    preset: id,
    esperado: ESPERADO[id],
    scaleResolutionDownBy: escala,
    maxBitrate,
    fonteFps: fonteFps?.fps ?? null,
    largurasVistas: [...new Set(estaveis.map((l) => l.w))],
    alturasVistas: [...new Set(estaveis.map((l) => l.h))],
    fps: estatisticas(estaveis.map((l) => l.fps)),
    bitrate: estatisticas(estaveis.map((l) => l.bitrate)),
    bpp: estatisticas(estaveis.map((l) => l.bpp)),
    qp: estatisticas(estaveis.map((l) => l.qp)),
    encodeMs: estatisticas(estaveis.map((l) => l.encodeMs)),
    reducaoTotal: estatisticas(estaveis.map((l) => l.reducaoTotal)),
    limitacoes: [...new Set(estaveis.map((l) => l.limit))],
    amostras: linhas,
  };
  varredura.push(item);
  console.log(
    `   ${id.padEnd(9)} alvo ${String(ESPERADO[id][0]).padStart(4)}x${String(ESPERADO[id][1]).padEnd(4)}` +
      ` scale=${fmt(escala, 3)} teto=${fmt(mbps(maxBitrate), 2)}Mb` +
      ` | codificado ${item.largurasVistas.join('/')}x${item.alturasVistas.join('/')}` +
      ` (reducao total ${fmt(item.reducaoTotal.mediana, 2)}x)` +
      ` fps~${fmt(item.fps.mediana, 0)}` +
      ` ${fmt(mbps(item.bitrate.mediana), 2)}Mb` +
      ` bpp ${fmt(item.bpp.min, 3)}/${fmt(item.bpp.mediana, 3)}/${fmt(item.bpp.max, 3)}` +
      ` QP~${fmt(item.qp.mediana, 1)} enc~${fmt(item.encodeMs.mediana, 1)}ms` +
      ` limit=${item.limitacoes.join(',')}`,
  );
}
  void rotulo;
  return varredura;
}

const varredura = await varrerPresets('fluidez');
relatorio.varreduraPresets = varredura;

/**
 * Controle: a MESMA varredura com adaptação de resolução DESLIGADA.
 *
 * Na varredura de cima duas coisas mexem em pixel ao mesmo tempo — o nosso
 * `scaleResolutionDownBy` e o *quality scaler* do Chromium, que derruba
 * resolução por conta própria quando o QP passa do limiar (e que reporta
 * `qualityLimitationReason: 'bandwidth'`, não `'cpu'`). Com as duas juntas não
 * dá para dizer de quem foi a redução.
 *
 * `prioridade: 'nitidez'` põe `degradationPreference: maintain-resolution`, e
 * aí o navegador só pode cortar QUADRO. Toda mudança de resolução que sobrar é
 * nossa, e a igualdade `frameWidth === 1920 / scaleResolutionDownBy` vira
 * prova direta. (O modo também baixa o alvo para 30fps — é o que a ADR 0009
 * define, e não atrapalha a medição de pixel.)
 */
console.log('\n[4b] CONTROLE — mesma varredura em `nitidez` (maintain-resolution)');
await host.evaluate(async () => {
  await window.__transport.setPrioridade('nitidez');
});
await esperar(3000);
const varreduraControle = await varrerPresets('nitidez');
relatorio.varreduraControle = varreduraControle;
await host.evaluate(async () => {
  await window.__transport.setPrioridade('fluidez');
});
await esperar(3000);

/* ---- 5. A malha do orçamento abre? ---------------------------------- */
console.log('\n[5] Malha do orçamento — availableOutgoingBitrate e governador, 60s');
const SEG_ORCAMENTO = Number(process.env.SEG_ORCAMENTO ?? 62);

await host.evaluate(async () => {
  // Volta ao topo da escada e monta o governador REAL da sessão.
  await window.__transport.setPreset(window.__shared.PRESET_1080P60);
  const { UplinkGovernor } = await import('/src/core/media/uplink-governor.ts');
  const { StatsSampler } = await import('/src/core/media/stats-sampler.ts');
  const { presetParaOrcamento } = await import('/src/core/media/presets.ts');
  window.__gov = new UplinkGovernor();
  window.__govId = Math.random().toString(36).slice(2, 8);
  window.__sampler = new StatsSampler('outbound');
  window.__presetParaOrcamento = presetParaOrcamento;
  window.__presetAtual = 'p1080p60';
});

const serie = [];
for (let s = 0; s < SEG_ORCAMENTO; s += 1) {
  await esperar(1000);
  const passo = await host.evaluate(async () => {
    // Reproduz `broadcast-session.applyUplinkCeiling` sem a UI: mesma leitura,
    // mesmo governador, mesma tradução de orçamento em degrau.
    const stats = await window.__transport.getAggregateStats();
    if (stats === null) return null;
    const media =
      stats.availableBps === null ? null : stats.availableBps / Math.max(1, stats.paresMedidos);
    const porEspectador =
      media === null
        ? null
        : stats.piorAvailableBps === null
          ? media
          : Math.min(media, stats.piorAvailableBps);
    const decisao = window.__gov.observe(porEspectador);
    let aplicou = null;
    if (decisao !== null) {
      await window.__transport.setUplinkBudget(decisao.bps);
      const id = window.__presetParaOrcamento(decisao.bps, 'fluidez');
      if (id !== window.__presetAtual) {
        window.__presetAtual = id;
        await window.__transport.setPreset(window.__shared.PRESETS[id]);
      }
      aplicou = { bps: decisao.bps, preset: id };
    }
    const cru = await window.__amostra();
    const params = window.__params();
    return {
      stats,
      porEspectador,
      orcamento: window.__gov.orcamento,
      estimativa: window.__gov.estimativa,
      // Estado interno do governador: sem isto não dá para distinguir
      // "não decidiu" de "não foi chamado".
      govAmostras: window.__gov.amostras ?? null,
      govMedia: window.__gov.media ?? null,
      govId: window.__govId,
      aplicou,
      preset: window.__presetAtual,
      // O que de fato chegou ao sender — é aqui que se vê o orçamento virar
      // teto de encoder, ou não virar.
      senderMaxBitrate:
        params[0]?.senders?.find((s) => s.kind === 'video')?.encodings?.[0]?.maxBitrate ?? null,
      senderScale:
        params[0]?.senders?.find((s) => s.kind === 'video')?.encodings?.[0]
          ?.scaleResolutionDownBy ?? null,
      cru: cru.map((c) => ({
        available: c.par?.availableOutgoingBitrate ?? null,
        rtt: c.par?.currentRoundTripTime ?? null,
        w: c.outbound?.frameWidth ?? null,
        h: c.outbound?.frameHeight ?? null,
        fps: c.outbound?.framesPerSecond ?? null,
        target: c.outbound?.targetBitrate ?? null,
        limit: c.outbound?.qualityLimitationReason ?? null,
        impl: c.outbound?.encoderImplementation ?? null,
      })),
    };
  });
  if (passo === null) continue;
  serie.push({ s, ...passo });
  if (s % 5 === 0 || passo.aplicou !== null) {
    console.log(
      `   t=${String(s).padStart(2)}s  available=${fmt(mbps(passo.cru[0]?.available), 2)}Mbps` +
        `  porEspectador=${fmt(mbps(passo.porEspectador), 2)}` +
        `  orçamento=${fmt(mbps(passo.orcamento), 2)}(n=${passo.govAmostras},id=${passo.govId})` +
        `  senderMax=${fmt(mbps(passo.senderMaxBitrate), 2)}` +
        `  preset=${passo.preset}` +
        `  enc=${passo.cru[0]?.w}x${passo.cru[0]?.h}@${fmt(passo.cru[0]?.fps, 0)}` +
        `  bitrate=${fmt(mbps(passo.stats.bitrateBps), 2)}Mbps  bpp=${fmt(passo.stats.bpp, 3)}` +
        `${passo.aplicou ? `   <<< aplicou ${fmt(mbps(passo.aplicou.bps), 2)}Mbps → ${passo.aplicou.preset}` : ''}`,
    );
  }
}
const disponiveis = serie.map((p) => p.cru[0]?.available ?? null);
const orcamentos = serie.map((p) => p.orcamento);
relatorio.orcamento = {
  serie,
  availableStats: estatisticas(disponiveis),
  orcamentoStats: estatisticas(orcamentos),
  primeiroOrcamento: orcamentos.find((o) => o !== null) ?? null,
  ultimoOrcamento: orcamentos.at(-1) ?? null,
  aplicacoes: serie.filter((p) => p.aplicou !== null).map((p) => ({ s: p.s, ...p.aplicou })),
};
console.log(
  `   available: min ${fmt(mbps(relatorio.orcamento.availableStats.min), 2)} / mediana ${fmt(mbps(relatorio.orcamento.availableStats.mediana), 2)} / max ${fmt(mbps(relatorio.orcamento.availableStats.max), 2)} Mbps`,
);
console.log(
  `   orçamento: primeiro ${fmt(mbps(relatorio.orcamento.primeiroOrcamento), 2)} → último ${fmt(mbps(relatorio.orcamento.ultimoOrcamento), 2)} Mbps em ${relatorio.orcamento.aplicacoes.length} aplicações`,
);

/* ---- 6. bits por pixel na janela do orçamento ----------------------- */
const bppSerie = serie.map((p) => p.stats.bpp).filter((x) => typeof x === 'number' && x > 0);
relatorio.bpp = {
  janelaOrcamento: estatisticas(bppSerie),
  porPreset: varredura.map((v) => ({ preset: v.preset, ...v.bpp })),
};
console.log(
  `\n[6] bpp na janela do orçamento: min ${fmt(relatorio.bpp.janelaOrcamento.min, 3)} / mediana ${fmt(relatorio.bpp.janelaOrcamento.mediana, 3)} / max ${fmt(relatorio.bpp.janelaOrcamento.max, 3)}`,
);

/* ---- 8. Parâmetros idênticos com 2 e 3 espectadores ----------------- */
console.log('\n[8] Paridade de parâmetros entre senders (R5)');
const paridade = [];

async function medirParidade(n) {
  await esperar(4000);
  const params = await host.evaluate(() => window.__params());
  const video = params.flatMap((pc) =>
    pc.senders.filter((s) => s.kind === 'video').map((s) => ({ pc: pc.idx, ...s })),
  );
  const chave = (s) =>
    JSON.stringify({
      deg: s.degradationPreference,
      enc: s.encodings.map((e) => ({
        maxBitrate: e.maxBitrate,
        maxFramerate: e.maxFramerate,
        scale: e.scaleResolutionDownBy,
        np: e.networkPriority,
        active: e.active,
      })),
    });
  const chaves = video.map(chave);
  const unicas = [...new Set(chaves)];
  const amostras = await host.evaluate(() => window.__amostra());
  const item = {
    espectadores: n,
    sendersDeVideo: video.length,
    conjuntosDistintos: unicas.length,
    identicos: unicas.length <= 1,
    parametros: video,
    encoders: amostras.map((a) => ({
      impl: a.outbound?.encoderImplementation ?? null,
      w: a.outbound?.frameWidth ?? null,
      h: a.outbound?.frameHeight ?? null,
      fps: a.outbound?.framesPerSecond ?? null,
      ssrc: a.outbound?.ssrc ?? null,
    })),
    distintos: unicas,
  };
  paridade.push(item);
  console.log(
    `   ${n} espectador(es): ${video.length} senders de vídeo, ${unicas.length} conjunto(s) distinto(s) → ${unicas.length <= 1 ? 'IDÊNTICOS' : 'DIVERGENTES'}`,
  );
  for (const s of video) {
    const e = s.encodings[0] ?? {};
    console.log(
      `      pc#${s.pc} scale=${fmt(e.scaleResolutionDownBy, 3)} maxBitrate=${fmt(mbps(e.maxBitrate), 2)}Mbps maxFramerate=${e.maxFramerate} np=${e.networkPriority} deg=${s.degradationPreference}`,
    );
  }
  if (unicas.length > 1) for (const u of unicas) console.log(`      DIVERGÊNCIA: ${u}`);
  return item;
}

const viewer2 = await novaPagina('viewer2');
await viewer2.goto(`${WEB}/${SLUG}#k=${CONVITE}`, { waitUntil: 'domcontentloaded' });
await esperarFrames(viewer2, 30);
await medirParidade(2);

const viewer3 = await novaPagina('viewer3');
await viewer3.goto(`${WEB}/${SLUG}#k=${CONVITE}`, { waitUntil: 'domcontentloaded' });
await esperarFrames(viewer3, 30);
await medirParidade(3);

// Um degrau ao vivo com 3 espectadores: é onde a divergência de escala
// aparecia (peer novo com escala diferente do antigo).
await host.evaluate(async () => {
  await window.__transport.setPreset(window.__shared.PRESET_480P60);
});
await esperar(6000);
const aposTroca = await medirParidade('3 (após setPreset ao vivo)');
relatorio.paridade = paridade;
void aposTroca;

/* ---- 7c. O outro lado: o que o espectador reporta -------------------- */
console.log('\n[7c] Lado do espectador (inbound-rtp)');
const ladoViewer = await viewer1.evaluate(async () => {
  const pc = window.__pcs.find((p) => p.connectionState === 'connected');
  if (pc === undefined) return null;
  // Mesmo portão de privacidade do lado do transmissor: sem permissão de
  // câmera/microfone o Chromium não expõe `decoderImplementation`.
  let permissao = 'não pedida';
  let captura = null;
  try {
    captura = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    await new Promise((r) => setTimeout(r, 2000));
    permissao = 'concedida, captura viva durante a leitura';
  } catch (e) {
    permissao = `negada: ${String(e)}`;
  }
  // A leitura acontece ANTES de parar a captura: o portão do Chromium é a
  // captura ATIVA, não a permissão guardada.
  const report = await pc.getStats();
  if (captura !== null) for (const t of captura.getTracks()) t.stop();
  let inb = null;
  const codecs = new Map();
  report.forEach((s) => {
    if (s.type === 'codec') codecs.set(s.id, s);
    if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s;
  });
  const rec = pc.getReceivers().find((r) => r.track?.kind === 'video');
  return {
    permissao,
    campos: Object.keys(inb ?? {}),
    decoderImplementation: inb?.decoderImplementation ?? null,
    powerEfficientDecoder: inb?.powerEfficientDecoder ?? null,
    frameWidth: inb?.frameWidth ?? null,
    frameHeight: inb?.frameHeight ?? null,
    framesPerSecond: inb?.framesPerSecond ?? null,
    framesDropped: inb?.framesDropped ?? null,
    freezeCount: inb?.freezeCount ?? null,
    totalFreezesDuration: inb?.totalFreezesDuration ?? null,
    jitterBufferDelay: inb?.jitterBufferDelay ?? null,
    jitterBufferEmittedCount: inb?.jitterBufferEmittedCount ?? null,
    jitterBufferTargetDelay: inb?.jitterBufferTargetDelay ?? null,
    codec: inb?.codecId ? (codecs.get(inb.codecId)?.sdpFmtpLine ?? null) : null,
    // O que `minimizePlayoutDelay` escreveu, lido de volta do receptor.
    playoutDelayHint: rec?.playoutDelayHint ?? null,
    jitterBufferTarget: rec?.jitterBufferTarget ?? null,
  };
});
relatorio.espectador = ladoViewer;
const jbMedio =
  ladoViewer?.jitterBufferDelay && ladoViewer?.jitterBufferEmittedCount
    ? (ladoViewer.jitterBufferDelay / ladoViewer.jitterBufferEmittedCount) * 1000
    : null;
console.log(
  `   decoder=${ladoViewer?.decoderImplementation} recebendo ${ladoViewer?.frameWidth}x${ladoViewer?.frameHeight}@${fmt(ladoViewer?.framesPerSecond, 0)}` +
    ` freezes=${ladoViewer?.freezeCount} jitterBuffer médio=${fmt(jbMedio, 1)}ms` +
    ` (alvo pedido: jitterBufferTarget=${ladoViewer?.jitterBufferTarget}ms, playoutDelayHint=${ladoViewer?.playoutDelayHint}s)`,
);

/* ---- Fecha e grava --------------------------------------------------- */
mkdirSync(dirname(SAIDA), { recursive: true });
writeFileSync(SAIDA, JSON.stringify(relatorio, null, 2));
console.log(`\nrelatório bruto: ${SAIDA}`);

for (const p of paginas) await p.context().close().catch(() => {});
await browser.close();
console.log('\n=== FIM ===');
