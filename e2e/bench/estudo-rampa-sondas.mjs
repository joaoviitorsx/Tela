/**
 * Rampa do BWE e sondas por caminho novo (estudo 2, T1/T6) — em Chromium real.
 *
 * Pergunta: quando um espectador NOVO entra, em quanto tempo o
 * `availableOutgoingBitrate` do caminho dele chega ao orçamento do degrau, e as
 * sondas passam de 5 Mbps (`kDefaultMaxProbingBitrate`) sem `x-google-max-bitrate`
 * ou `b=AS`? Braços (aplicados na descrição remota do TRANSMISSOR, de fora, sem
 * tocar no produto):
 *
 *   base    o que o produto faz hoje (só `x-google-start-bitrate`)
 *   maxbr   + `x-google-max-bitrate=<teto do degrau>` em cada fmtp de vídeo
 *   as      + `b=AS:<teto do degrau>` na seção de vídeo
 *   maxbr40 + `x-google-max-bitrate=40000` (a montagem do E1 do estudo)
 *
 * Amostra a 5 Hz, por conexão, DESDE o `connected`: available, alvo e bytes
 * (do par de candidatos e do `outbound-rtp`). "Salto" = subida ≥ 2× entre duas
 * amostras (assinatura de sonda); "pico de fio" = maior taxa do par em 200 ms.
 *
 * LIMITES (escritos aqui porque são o que decide a leitura): é loopback, RTT ~0,
 * sem gargalo — o estimador por atraso nunca vê fila, então só mede a MECÂNICA
 * de subida (tampa de 1,5 x acked, sondas), nunca a reação a uma rede real. O
 * encoder é por software e a fonte sintética: o `acked` pode ser menor que em
 * produção, e é ele que tampa o available.
 *
 *   pnpm dev   (noutro terminal)
 *   node e2e/bench/estudo-rampa-sondas.mjs [--reps=3] [--segundos=22] [--preset=p1080p60]
 *        [--bracos=base,maxbr,as,maxbr40] [--json]
 */
import { chromium } from 'playwright';

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const REPS = Number(arg('reps', 3));
const SEGUNDOS = Number(arg('segundos', 22));
const PRESET = arg('preset', 'p1080p60');
const BRACOS = arg('bracos', 'base,maxbr,as,maxbr40').split(',');
const JSON_SAIDA = process.argv.includes('--json');
const SERIE = process.argv.includes('--serie');
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ?? chromium.executablePath();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Roda ANTES de qualquer script: guarda as conexões e aplica o braço no SDP remoto. */
function instrumentar(braco, tetoKbps) {
  const Orig = window.RTCPeerConnection;
  window.__pcs = [];
  const srd = Orig.prototype.setRemoteDescription;
  Orig.prototype.setRemoteDescription = function (desc, ...rest) {
    let usado = desc;
    if (typeof desc?.sdp === 'string' && braco !== 'base') {
      const alvo = braco === 'maxbr40' ? 40000 : tetoKbps;
      let sdp = desc.sdp;
      if (braco === 'maxbr' || braco === 'maxbr40') {
        sdp = sdp
          .split(/(?<=\n)/)
          .map((l) => {
            if (!l.startsWith('a=fmtp:') || !l.includes('profile-level-id=')) return l;
            const fim = l.endsWith('\r\n') ? '\r\n' : l.endsWith('\n') ? '\n' : '';
            return `${l.slice(0, l.length - fim.length)};x-google-max-bitrate=${alvo}${fim}`;
          })
          .join('');
      } else if (braco === 'as') {
        // `b=AS` vai logo depois do `c=` da seção de vídeo.
        sdp = sdp.replace(/(m=video[^\n]*\n(?:[^\n]*\n)*?c=[^\n]*\r?\n)/, `$1b=AS:${alvo}\r\n`);
      }
      usado = { type: desc.type, sdp };
      window.__aplicados = (window.__aplicados ?? 0) + 1;
    }
    return srd.call(this, usado, ...rest);
  };
  window.RTCPeerConnection = class extends Orig {
    constructor(...a) {
      super(...a);
      window.__pcs.push(this);
      window.__serie = window.__serie ?? new Map();
    }
  };
  // Amostrador a 5 Hz de TODAS as conexões, indexado por ordem de criação.
  setInterval(async () => {
    const t = performance.now();
    for (let i = 0; i < window.__pcs.length; i += 1) {
      const pc = window.__pcs[i];
      if (pc.connectionState !== 'connected') continue;
      let rel;
      try {
        rel = await pc.getStats();
      } catch {
        continue;
      }
      let o = null;
      let par = null;
      let selecionado = null;
      rel.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') o = s;
        if (s.type === 'transport' && s.selectedCandidatePairId) selecionado = s.selectedCandidatePairId;
      });
      // Só o par SELECIONADO tem `availableOutgoingBitrate` e os bytes do fio;
      // pegar "o último que deu certo" lia um par ocioso (a primeira versão
      // deste script fez isso e viu o available sumir).
      if (selecionado !== null) par = rel.get(selecionado) ?? null;
      if (par === null) continue;
      const serie = window.__serie.get(i) ?? [];
      serie.push({
        t,
        avail: par.availableOutgoingBitrate ?? null,
        parBytes: par.bytesSent ?? 0,
        rtpBytes: o?.bytesSent ?? 0,
        retx: o?.retransmittedBytesSent ?? 0,
        alvo: o?.targetBitrate ?? null,
        w: o?.frameWidth ?? null,
        fps: o?.framesPerSecond ?? null,
        rtt: par.currentRoundTripTime ?? null,
      });
      window.__serie.set(i, serie);
    }
  }, 200);
}

function fonte(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d', { alpha: false });
  const MW = 2800;
  const MH = 1800;
  const m = document.createElement('canvas');
  m.width = MW;
  m.height = MH;
  const mx = m.getContext('2d', { alpha: false });
  for (let i = 0; i < 3000; i += 1) {
    mx.fillStyle = `hsl(${Math.random() * 360} ${40 + Math.random() * 55}% ${12 + Math.random() * 60}%)`;
    const s = 6 + Math.random() * 80;
    mx.fillRect(Math.random() * MW, Math.random() * MH, s, s * (0.2 + Math.random()));
  }
  mx.font = 'bold 24px monospace';
  for (let i = 0; i < 700; i += 1) {
    mx.fillStyle = `hsl(${Math.random() * 360} 90% 75%)`;
    mx.fillText(Math.random().toString(36).slice(2, 10), Math.random() * MW, Math.random() * MH);
  }
  const loop = (agora) => {
    const t = agora / 1000;
    x.drawImage(m, (MW - w) / 2 + Math.sin(t * 0.9) * (MW - w) * 0.48, (MH - h) / 2 + Math.sin(t * 1.7) * (MH - h) * 0.48, w, h, 0, 0, w, h);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return c;
}

const mediana = (v) => {
  const o = v.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (o.length === 0) return null;
  return o.length % 2 ? o[(o.length - 1) / 2] : (o[o.length / 2 - 1] + o[o.length / 2]) / 2;
};
const mbps = (b) => (b === null || b === undefined ? 'n/d' : (b / 1e6).toFixed(2));

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

async function umaRodada(braco, rep, presetId) {
  const slug = `rp${braco.slice(0, 3)}${rep}${Math.random().toString(36).slice(2, 6)}`;
  const ctxH = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const host = await ctxH.newPage();
  host.on('pageerror', (e) => console.error(`  [host] pageerror: ${e.message}`));
  const tetoKbps = await (async () => 0)(); // preenchido abaixo, depois de saber o preset
  void tetoKbps;
  await host.route('**/src/main.tsx', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'export {};' }));
  // O teto do degrau vem do próprio pacote compartilhado, lido na página.
  await host.addInitScript({ content: `window.__fonte = ${fonte.toString()};` });
  await host.goto(WEB, { waitUntil: 'domcontentloaded' });
  const teto = await host.evaluate(async (id) => {
    const shared = await import('/node_modules/@tela/shared/dist/index.js');
    return Math.round(shared.PRESETS[id].main.maxBitrate / 1000);
  }, presetId);
  // A instrumentação precisa existir antes de o transporte criar conexões; a
  // página já carregou, então ela é injetada agora e vale para as conexões novas.
  await host.evaluate(`(${instrumentar.toString()})(${JSON.stringify(braco)}, ${teto})`);
  await host.evaluate(
    async ([s, id]) => {
      const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
      const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
      const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
      const shared = await import('/node_modules/@tela/shared/dist/index.js');
      const preset = shared.PRESETS[id];
      const track = window.__fonte(preset.width ?? 1920, preset.height ?? 1080).captureStream(60).getVideoTracks()[0];
      track.contentHint = shared.CONTENT_HINT;
      const transport = makeMeshTransport({
        channel: makeWsSignaling(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`),
        scheduler: makeBrowserScheduler(),
      });
      await transport.host(s, 'r'.repeat(43));
      transport.on('pedido', (p) => transport.responderPedido(p.peerId, true));
      await transport.publishVideo(track, preset);
    },
    [slug, presetId],
  );

  const viewers = [];
  const entrar = async (rotulo) => {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const p = await ctx.newPage();
    await p.addInitScript((a) => {
      localStorage.setItem('tela.apelido', a);
      localStorage.setItem('tela.semApp', '1');
    }, rotulo);
    await p.goto(`${WEB}/${slug}`, { waitUntil: 'domcontentloaded' });
    viewers.push(ctx);
  };
  await entrar('v0');
  await esperar(12_000);
  await entrar('v1'); // o caminho NOVO, com a sala já no ar
  await esperar(SEGUNDOS * 1000);

  const series = await host.evaluate(() => [...(window.__serie ?? new Map()).entries()]);
  const aplicados = await host.evaluate(() => window.__aplicados ?? 0);
  await ctxH.close();
  for (const v of viewers) await v.close();
  return { braco, teto, series, aplicados };
}

/** Métricas de UMA série (um caminho), tempo relativo ao primeiro `connected`. */
function medir(serie, tetoBps) {
  if (serie.length < 4) return null;
  const t0 = serie[0].t;
  const pts = serie.map((p, i) => {
    const ant = serie[i - 1];
    const dt = ant ? (p.t - ant.t) / 1000 : null;
    return { ...p, rel: (p.t - t0) / 1000, fio: ant && dt > 0 ? ((p.parBytes - ant.parBytes) * 8) / dt : null, rtp: ant && dt > 0 ? ((p.rtpBytes - ant.rtpBytes) * 8) / dt : null };
  });
  const primeiroAlcance = (frac) => pts.find((p) => p.avail !== null && p.avail >= tetoBps * frac)?.rel ?? null;
  let saltos = 0;
  for (let i = 1; i < pts.length; i += 1) if (pts[i - 1].avail > 0 && pts[i].avail >= 2 * pts[i - 1].avail) saltos += 1;
  const fios = pts.map((p) => p.fio).filter((v) => v !== null);
  return {
    amostras: pts.length,
    availEm1s: pts.find((p) => p.rel >= 1)?.avail ?? null,
    availEm3s: pts.find((p) => p.rel >= 3)?.avail ?? null,
    availEm6s: pts.find((p) => p.rel >= 6)?.avail ?? null,
    availFinal: pts.at(-1).avail,
    availMax: Math.max(...pts.map((p) => p.avail ?? 0)),
    t50: primeiroAlcance(0.5),
    t90: primeiroAlcance(0.9),
    t100: primeiroAlcance(1.0),
    // O que importa para a imagem é o ALVO do encoder, não o available.
    alvoT75: pts.find((p) => p.alvo !== null && p.alvo >= tetoBps * 0.75)?.rel ?? null,
    alvoEm1s: pts.find((p) => p.rel >= 1)?.alvo ?? null,
    alvoEm6s: pts.find((p) => p.rel >= 6)?.alvo ?? null,
    larguraEm6s: pts.find((p) => p.rel >= 6)?.w ?? null,
    saltos2x: saltos,
    picoFio: Math.max(...fios),
    rtpMedio: mediana(pts.slice(-15).map((p) => p.rtp)),
    fioMedio: mediana(pts.slice(-15).map((p) => p.fio)),
    rtt: mediana(pts.map((p) => p.rtt).filter((v) => v !== null)),
    largura: pts.at(-1).w,
  };
}

const resultados = [];
for (let rep = 0; rep < REPS; rep += 1) {
  // Braços intercalados dentro de cada repetição: a deriva da máquina cai em todos.
  for (const braco of BRACOS) {
    const r = await umaRodada(braco, rep, PRESET);
    const caminhos = r.series.map(([i, s]) => ({ caminho: i, ...medir(s, r.teto * 1000) }));
    resultados.push({ braco, rep, teto: r.teto, aplicados: r.aplicados, caminhos });
    const novo = caminhos.at(-1);
    if (SERIE) {
      const bruta = r.series.at(-1)?.[1] ?? [];
      const t0 = bruta[0]?.t ?? 0;
      for (const p of bruta.slice(0, 40)) {
        console.log(`   +${((p.t - t0) / 1000).toFixed(1).padStart(5)}s avail=${mbps(p.avail)} alvo=${mbps(p.alvo)} rtp(acum)=${(p.rtpBytes / 1e6).toFixed(2)}MB ${p.w}px ${p.fps?.toFixed(0)}fps rtt=${p.rtt}`);
      }
    }
    if (!JSON_SAIDA) {
      console.log(
        `rep${rep} ${braco.padEnd(7)} SDPs alterados=${r.aplicados} | caminho novo: avail 1s=${mbps(novo?.availEm1s)} 3s=${mbps(novo?.availEm3s)} 6s=${mbps(novo?.availEm6s)} fim=${mbps(novo?.availFinal)} max=${mbps(novo?.availMax)} Mbps · t50=${novo?.t50 ?? 'n/a'}s t90=${novo?.t90 ?? 'n/a'}s · saltos2x=${novo?.saltos2x} · pico de fio=${mbps(novo?.picoFio)} · rtp(fim)=${mbps(novo?.rtpMedio)} · ${novo?.largura}px`,
      );
    }
  }
}
await browser.close();

if (JSON_SAIDA) {
  console.log(JSON.stringify(resultados));
} else {
  console.log(`\n== resumo (mediana de ${REPS}; teto do degrau ${PRESET} = ${mbps(resultados[0]?.teto * 1000)} Mbps; caminho = o ÚLTIMO a entrar) ==`);
  for (const braco of BRACOS) {
    const rs = resultados.filter((r) => r.braco === braco).map((r) => r.caminhos.at(-1)).filter(Boolean);
    const m = (k) => mediana(rs.map((r) => r[k]));
    console.log(
      `${braco.padEnd(7)} alvo@1s=${mbps(m('alvoEm1s'))} @6s=${mbps(m('alvoEm6s'))} t75(alvo)=${m('alvoT75')} larg@6s=${m('larguraEm6s')} | avail@1s=${mbps(m('availEm1s'))} @3s=${mbps(m('availEm3s'))} @6s=${mbps(m('availEm6s'))} fim=${mbps(m('availFinal'))} max=${mbps(m('availMax'))} | t50=${m('t50')} t90=${m('t90')} | saltos2x=${m('saltos2x')} | pico de fio=${mbps(m('picoFio'))} | rtp=${mbps(m('rtpMedio'))}`,
    );
  }
}
