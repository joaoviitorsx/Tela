/**
 * E2 da ADR 0031 (cascata de repasse): repassar o quadro JÁ CODIFICADO, sem
 * recodificar, por um espectador (R) a outro (B) — em Chromium real.
 *
 *   node e2e/bench/estudo-repasse-e2.mjs
 *   SEGUNDOS=60 RUNS=3 node e2e/bench/estudo-repasse-e2.mjs --cenarios=latencia,filhos,chave
 *
 * Nada de produção é alterado. O protótipo vive aqui dentro: um servidor HTTP
 * local entrega a página da bancada e transpila, sob demanda, dois módulos
 * REAIS de `apps/web/src` (`FilaDeInjecao`, `CodificadorWebCodecs`), de modo que
 * o anfitrião é o "um encode, N envios" de produção. O que é novo é só o
 * repassador R: um `RTCRtpScriptTransform` de RECEPÇÃO copia cada quadro
 * codificado para a fila de injeção do próprio worker de R e o devolve intacto
 * (R continua decodificando); R tem uma segunda `RTCPeerConnection` por filho,
 * cujo sender carrega uma isca 160x90 com o transform de injeção.
 *
 * Papéis, cada um num Chromium PRÓPRIO (`chromium.launchServer`, para ler a CPU
 * da árvore de processos em /proc):
 *   host  — fonte sintética 1280x720@60 com movimento + faixa binária com o
 *           número do quadro; um encode, N envios
 *   A     — espectador direto do host (controle)
 *   R     — espectador que repassa
 *   B     — navegador dos filhos de R (B1..Bk) e do controle A2 (direto do host)
 *
 * Latência (relógio comum: performance.timeOrigin + performance.now, mesma
 * máquina): o número do quadro lido no vídeo exibido, por rVFC + canvas, contra
 * o instante em que o host o desenhou. É a medida AUTORITATIVA. A outra
 * (`abs-capture-time` + getSynchronizationSources) sai junto, para dizer o que
 * o carimbo esconde na cascata.
 *
 * Sinalização: troca direta de SDP pelo orquestrador (sem trickle, só
 * candidatos de host, mDNS desligado). O experimento não usa o protocolo real.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cpus, loadavg, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(RAIZ, 'apps/web/package.json'));
const ts = require('typescript');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const CHROME = process.env.CHROME ?? chromium.executablePath();
const SEGUNDOS = Number(process.env.SEGUNDOS ?? 60);
const RUNS = Number(process.env.RUNS ?? 3);
const AQUECIMENTO_MS = Number(process.env.AQUECIMENTO_MS ?? 10_000);
const BITRATE = Number(process.env.BITRATE ?? 6_000_000);
const JITTER_MS = Number(process.env.JITTER_MS ?? 20);
const CENARIOS = String(args.cenarios ?? 'latencia,filhos,chave').split(',');
let TICK_R = process.env.TICK_R ?? 'chegada';      // 'chegada' (produção) | 'livre' (isca de R tica sozinha, em TICK_HZ)
const TICK_HOST = process.env.TICK_HOST ?? 'chegada';
const TICK_HZ = Number(process.env.TICK_HZ ?? 120);
const MEDIR_R = (process.env.MEDIR_R ?? '1') === '1';   // 0: R não lê a faixa (sem rVFC/canvas) — para medir só o custo do repasse
const MAXFPS = Number(process.env.MAXFPS ?? 0);          // maxFramerate dos senders-isca (0 = padrão do navegador)
const ESTRATEGIA = process.env.ESTRATEGIA ?? 'upstream';   // 'upstream' | 'cache' (como R atende a entrada/PLI de um filho)
const IDR_MS = Number(process.env.IDR_MS ?? 0);             // IDR periódico no anfitrião (0 = só por pedido)
const FILHOS = String(args.filhos ?? '1,3,6').split(',').map(Number);

/**
 * A máquina é compartilhada (outros processos de teste/build). Antes de cada
 * rodada espera o loadavg de 1 min cair abaixo do limite; passou do prazo,
 * roda mesmo assim e a rodada sai marcada como "contaminada" (carga alta
 * antes OU depois). Rodadas contaminadas são repetidas pelo orquestrador.
 */
const CARGA_MAX = Number(process.env.CARGA_MAX ?? 4.5);
async function esperarCalma(prazoMs = 600_000) {
  const t0 = Date.now();
  while (loadavg()[0] > CARGA_MAX && Date.now() - t0 < prazoMs) await esperar(5000);
  return loadavg()[0] <= CARGA_MAX;
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (v) => pct(v, 0.5);
function pct(v, p) {
  const x = v.filter(Number.isFinite).sort((a, b) => a - b);
  if (x.length === 0) return NaN;
  return x[Math.min(x.length - 1, Math.max(0, Math.round(p * (x.length - 1))))];
}
const media = (v) => { const x = v.filter(Number.isFinite); return x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN; };
const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : 'n/d');

// ───────────────────────── página da bancada ─────────────────────────

const WORKER = String.raw`
import { FilaDeInjecao } from '/src/core/media/fila-de-injecao.js';

const fila = new FilaDeInjecao(() => performance.now());
let modo = 'viewer';
let tickLivre = false;
let estrategia = 'upstream';
let receptor = null;           // transformer de recepção de R (para sendKeyFrameRequest)
const passa = new Map();       // id -> transformer (B: PLI de teste)
let seqR = 0;
let ultimoIdr = -1;
let ultimoPedidoAcima = -1e9;
const S = zerar();
function zerar() {
  return { recebidos: 0, chavesRecebidas: 0, bytes: 0, msCopia: [], latFila: [], injetados: 0, chavesInjetadas: 0,
    slots: 0, pedidosAcima: 0, pedidosAcimaFeitos: 0, replays: 0, metaReceber: null, metaIsca: null,
    temSetMetadata: null, temSendKeyFrameRequest: null, temNovoQuadro: typeof RTCEncodedVideoFrame === 'function' };
}

setInterval(() => postMessage({ tipo: 'atraso', quadros: fila.atraso() }), 100);

self.onmessage = (e) => {
  const m = e.data;
  if (m.tipo === 'config') { modo = m.modo; estrategia = m.estrategia; tickLivre = m.tick === 'livre'; }
  else if (m.tipo === 'chunk') fila.chegou({ seq: m.seq, chave: m.chave, dados: m });
  else if (m.tipo === 'zerar') Object.assign(S, zerar());
  else if (m.tipo === 'stats') {
    const q = (v, p) => { const x = [...v].sort((a, b) => a - b); return x.length ? x[Math.min(x.length - 1, Math.round(p * (x.length - 1)))] : null; };
    postMessage({ tipo: 'stats', S: { ...S, msCopia: { n: S.msCopia.length, p50: q(S.msCopia, .5), p95: q(S.msCopia, .95), max: q(S.msCopia, 1) },
      latFila: { n: S.latFila.length, p50: q(S.latFila, .5), p95: q(S.latFila, .95), max: q(S.latFila, 1) } }, id: m.id });
  } else if (m.tipo === 'pli') {
    const t = passa.get(m.id);
    if (t) t.sendKeyFrameRequest().catch((err) => postMessage({ tipo: 'erro', msg: 'pli: ' + err }));
  }
};

function pedirAcima(motivo) {
  S.pedidosAcima += 1;
  if (modo === 'host') { postMessage({ tipo: 'chave', motivo, senders: fila.senders() }); return; }
  const agora = performance.now();
  if (agora - ultimoPedidoAcima < 500 || !receptor) return;   // coalescência de R: 1 pedido a cada 500 ms
  ultimoPedidoAcima = agora;
  S.pedidosAcimaFeitos += 1;
  receptor.sendKeyFrameRequest().catch((err) => postMessage({ tipo: 'erro', msg: 'sendKeyFrameRequest: ' + err }));
}

self.onrtctransform = ({ transformer }) => {
  const o = transformer.options;
  if (o.papel === 'receber') receber(transformer);
  else if (o.papel === 'passa') { passa.set(o.id, transformer); transformer.readable.pipeTo(transformer.writable); }
  else isca(transformer, o.id);
};

async function receber(t) {
  receptor = t;
    const r = t.readable.getReader(); const w = t.writable.getWriter();
  for (;;) {
    const { value: q, done } = await r.read();
    if (done || q === undefined) return;
    const t0 = performance.now();
    const chave = q.type === 'key';
    const md = q.getMetadata();
    if (S.metaReceber === null) S.metaReceber = JSON.parse(JSON.stringify(md));
    S.temSetMetadata = typeof q.setMetadata === 'function'; S.temSendKeyFrameRequest = typeof t.sendKeyFrameRequest === 'function';
    S.recebidos += 1; S.bytes += q.data.byteLength;
    const seq = seqR++;
    if (chave) { S.chavesRecebidas += 1; ultimoIdr = seq; }
    // A cópia vai para a fila de injeção deste mesmo worker, e a isca do filho é cutucada.
    const dados = q.data.slice(0);
    fila.chegou({ seq, chave, dados: { seq, chave, dados, width: md.width ?? 0, height: md.height ?? 0, chegouEm: t0 } });
    if (fila.senders() > 0 && !tickLivre) postMessage({ tipo: 'tique' });
    if (S.msCopia.length < 20000) S.msCopia.push(performance.now() - t0);
    await w.write(q);   // o original segue: R continua decodificando
  }
}

async function isca(t, id) {
  fila.entrou(id);
  const leitor = t.readable.getReader(); const escritor = t.writable.getWriter();
  let vistos = 0; let motivo = 'entrada';
  for (;;) {
    const { value: q, done } = await leitor.read();
    if (done || q === undefined) { fila.saiu(id); return; }
    vistos += 1; S.slots += 1;
    if (S.metaIsca === null) S.metaIsca = JSON.parse(JSON.stringify(q.getMetadata()));
    if (q.type === 'key' && vistos > 1) { fila.pediuChave(id); motivo = 'pli'; }
    // Estratégia "cache": quem espera IDR recomeça do último IDR guardado (rajada de P por ticks extras).
    if (modo === 'relay' && estrategia === 'cache') {
      const st = fila.estados.get(id);
      if (st && st.esperandoChave && ultimoIdr >= 0 && ultimoIdr >= fila.primeiroSeq()) {
        st.esperandoChave = false; st.proximo = ultimoIdr; S.replays += 1;
      }
    }
    const d = fila.vaga(id);
    if (d.tipo === 'descartar') { if (d.pedirChave) pedirAcima(motivo); continue; }
    motivo = 'atrasado';
    const real = d.quadro.dados;
    if (real.chegouEm !== undefined && S.latFila.length < 20000) S.latFila.push(performance.now() - real.chegouEm);
    q.data = real.dados.slice(0);
    S.injetados += 1; if (d.quadro.chave) S.chavesInjetadas += 1;
    if (modo === 'relay' && estrategia === 'cache' && !tickLivre && fila.atraso() >= 2) postMessage({ tipo: 'tique', n: Math.min(3, fila.atraso()) });
    await escritor.write(q);
  }
}
`;

const PAGINA = String.raw`<!doctype html><meta charset=utf-8><title>E2</title>
<body style="margin:0;background:#000"><script type="module">
import { CodificadorWebCodecs } from '/src/adapters/webcodecs-codificador.js';
const unix = () => performance.timeOrigin + performance.now();
const URI = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';
const H = (window.H = { pcs: new Map(), rec: new Map(), videos: new Map(), jitterMs: 20 });

H.iniciarWorker = (modo, estrategia, tick, hz) => {
  H.modo = modo; H.livre = tick === 'livre';
  H.worker = new Worker('/worker.js', { type: 'module' });
  H.worker.postMessage({ tipo: 'config', modo, estrategia, tick });
  if (H.livre) H.hzLivre = hz;
  H.erros = [];
  H.worker.onmessage = (e) => {
    const m = e.data;
    if (m.tipo === 'tique') { const n = m.n ?? 1; for (let i = 0; i < n; i++) i === 0 ? H.isca?.tique() : setTimeout(() => H.isca?.tique(), i * 2); }
    else if (m.tipo === 'chave') H.cod?.pedirChave(m.motivo, m.senders);
    else if (m.tipo === 'atraso') H.cod?.definirAtraso(m.quadros);
    else if (m.tipo === 'stats') H._stats?.(m.S);
    else if (m.tipo === 'erro') H.erros.push(m.msg);
  };
};
H.statsWorker = () => new Promise((res) => { H._stats = res; H.worker.postMessage({ tipo: 'stats' }); });
H.zerarWorker = () => H.worker.postMessage({ tipo: 'zerar' });

function criarIsca() {
  const c = document.createElement('canvas'); c.width = 160; c.height = 90;
  const ctx = c.getContext('2d', { alpha: false }); ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, 160, 90);
  const trilha = c.captureStream(0).getVideoTracks()[0]; trilha.contentHint = 'motion';
  let par = false;
  return { trilha, tique: () => { par = !par; ctx.fillStyle = par ? '#101010' : '#111111'; ctx.fillRect(0, 0, 1, 1); trilha.requestFrame(); } };
}
H.criarIsca = () => { H.isca = criarIsca(); };

// Fonte sintética 1280x720 com movimento e a faixa binária com o número do quadro.
H.hostIniciar = async ({ idrMs, bitrate }) => {
  const W = 1280, Hh = 720, N = 24;
  const c = document.createElement('canvas'); c.width = W; c.height = Hh; document.body.appendChild(c);
  const ctx = c.getContext('2d', { alpha: false });
  H.t0 = []; H.ids = []; let id = 0; let t = 0;
  const rng = (s) => { let x = s; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; };
  const desenhar = () => {
    t += 1 / 60; id += 1;
    const g = ctx.createLinearGradient(0, 0, W, Hh);
    g.addColorStop(0, 'hsl(' + ((t * 40) % 360) + ',60%,35%)'); g.addColorStop(1, 'hsl(' + ((t * 40 + 120) % 360) + ',60%,20%)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, Hh);
    const r = rng(1234);
    for (let i = 0; i < 60; i++) {   // "partículas": conteúdo com movimento que cobre a tela
      const x = (r() * W + Math.sin(t * (1 + r()) + i) * 140 + t * 90 * (r() - .5)) % W, y = ((r() * Hh + t * 120 * (r() + .2)) % (Hh - 60)) + 40;
      ctx.fillStyle = 'hsl(' + ((i * 17 + t * 90) % 360) + ',85%,60%)'; ctx.fillRect(x, y, 24 + r() * 90, 14 + r() * 60);
    }
    ctx.save(); ctx.translate(W / 2, Hh / 2 + 20); ctx.rotate(t * 2);
    for (let i = 0; i < 8; i++) { ctx.fillStyle = i % 2 ? '#fff' : '#111'; ctx.fillRect(-300 + i * 14, -100, 10, 200); }
    ctx.restore();
    // faixa: 20 bits do id + 4 de verificação, células de 53 px, 24 px de altura
    const chk = (id * 7 + 3) & 15; const bits = [];
    for (let i = 19; i >= 0; i--) bits.push((id >> i) & 1);
    for (let i = 3; i >= 0; i--) bits.push((chk >> i) & 1);
    for (let i = 0; i < N; i++) { ctx.fillStyle = bits[i] ? '#fff' : '#000'; ctx.fillRect(Math.floor(i * W / N), 0, Math.ceil(W / N), 24); }
    H.ids.push(id); H.t0.push(unix());
  };
  const laco = () => { desenhar(); requestAnimationFrame(laco); };
  desenhar();
  const trilha = c.captureStream(60).getVideoTracks()[0]; trilha.contentHint = 'motion';
  requestAnimationFrame(laco);
  H.criarIsca();
  const aoCapturar = () => { if (!H.livre) H.isca.tique(); };
  if (H.livre) setInterval(() => H.isca.tique(), 1000 / H.hzLivre);
  H.cod = new CodificadorWebCodecs((chunk, tr) => H.worker.postMessage({ tipo: 'chunk', ...chunk }, tr), () => performance.now(), aoCapturar);
  await H.cod.iniciar(trilha, { width: W, height: Hh, fps: 60, bitrate, limitadoPelaEstimativa: false });
  if (idrMs > 0) setInterval(() => H.cod.pedirChave('periodico', 0), idrMs);
};
H.hostLog = () => ({ ids: H.ids, t0: H.t0 });

const esperarIce = (pc) => new Promise((res) => {
  if (pc.iceGatheringState === 'complete') return res();
  pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res());
  setTimeout(res, 4000);
});
function preparar(tr) {
  try { tr.setHeaderExtensionsToNegotiate(tr.getHeaderExtensionsToNegotiate().map((e) => e.uri === URI ? { uri: e.uri, direction: 'sendrecv' } : e)); } catch (e) {}
  try {
    const caps = RTCRtpSender.getCapabilities('video').codecs; const h = caps.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
    tr.setCodecPreferences([...h, ...caps.filter((c) => c.mimeType.toLowerCase() !== 'video/h264')]);
  } catch (e) {}
}
H.enviarOferta = async (id) => {
  const pc = new RTCPeerConnection({ iceServers: [] }); H.pcs.set(id, pc);
  const tr = pc.addTransceiver(H.isca.trilha, { direction: 'sendonly' });
  tr.sender.transform = new RTCRtpScriptTransform(H.worker, { papel: 'isca', id });
  preparar(tr);
  await pc.setLocalDescription(await pc.createOffer());
  try { const p = tr.sender.getParameters(); p.encodings[0].maxBitrate = 20_000_000; if (H.maxfps) p.encodings[0].maxFramerate = H.maxfps; await tr.sender.setParameters(p); } catch (e) { H.erros.push('setParameters ' + e); }
  await esperarIce(pc);
  return pc.localDescription.sdp;
};
H.aplicarResposta = (id, sdp) => H.pcs.get(id).setRemoteDescription({ type: 'answer', sdp });
H.responder = async (id, oferta, { relay, passa, medir }) => {
  const pc = new RTCPeerConnection({ iceServers: [] }); H.pcs.set(id, pc);
  const criado = unix();
  pc.ontrack = (e) => {
    const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.playsInline = true; v.style.width = '160px';
    v.srcObject = new MediaStream([e.track]); document.body.appendChild(v); v.play().catch(() => {}); H.videos.set(id, v);
    if (medir) H.medir(id, criado);
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: oferta });
  for (const tr of pc.getTransceivers()) {
    if (relay) tr.receiver.transform = new RTCRtpScriptTransform(H.worker, { papel: 'receber', id });
    else if (passa) tr.receiver.transform = new RTCRtpScriptTransform(H.worker, { papel: 'passa', id });
    try { tr.receiver.jitterBufferTarget = H.jitterMs; } catch (e) {}
  }
  await pc.setLocalDescription(await pc.createAnswer());
  await esperarIce(pc);
  return pc.localDescription.sdp;
};
H.fechar = (id) => { H.pcs.get(id)?.close(); H.pcs.delete(id); H.videos.get(id)?.remove(); H.videos.delete(id); const r = H.rec.get(id); if (r) r.ativo = false; };
H.estado = (id) => { const pc = H.pcs.get(id); return pc ? pc.connectionState : 'nenhum'; };

// Leitura da faixa por rVFC + canvas; carimbo abs-capture-time por getSynchronizationSources.
H.medir = (id, criado) => {
  const v = H.videos.get(id); const pc = H.pcs.get(id);
  const rec = { ativo: true, criado: criado ?? unix(), primeiro: null, ids: [], disp: [], rtp: [], capRef: [], rtpRef: [], invalidos: 0, w: 0, h: 0, semCaptura: 0 };
  H.rec.set(id, rec);
  const cv = new OffscreenCanvas(320, 180); const cx = cv.getContext('2d', { willReadFrequently: true });
  const rx = pc.getReceivers().find((r) => r.track.kind === 'video');
  const laco = (agora, md) => {
    if (!rec.ativo) return;
    try {
      cx.drawImage(v, 0, 0, 320, 180);
      const px = cx.getImageData(0, 2, 320, 1).data; let val = 0;
      for (let i = 0; i < 24; i++) { const x = Math.floor((i + .5) * 320 / 24) * 4; const l = (px[x] + px[x + 1] + px[x + 2]) / 3; val = (val << 1) | (l > 128 ? 1 : 0); }
      const idq = val >> 4, chk = val & 15;
      if (((idq * 7 + 3) & 15) !== chk || idq === 0) rec.invalidos++;
      else {
        rec.ids.push(idq); rec.disp.push(performance.timeOrigin + (md.expectedDisplayTime || agora)); rec.rtp.push(md.rtpTimestamp ?? -1);
        const s = rx.getSynchronizationSources().find((x) => typeof x.captureTimestamp === 'number');
        if (s) { rec.capRef.push(s.captureTimestamp); rec.rtpRef.push(s.rtpTimestamp); } else { rec.capRef.push(null); rec.rtpRef.push(null); rec.semCaptura++; }
        if (rec.primeiro === null) rec.primeiro = unix();
        rec.w = v.videoWidth; rec.h = v.videoHeight;
      }
    } catch (e) { rec.erro = String(e); }
    v.requestVideoFrameCallback(laco);
  };
  v.requestVideoFrameCallback(laco);
};
H.zerarMedida = (id) => { const r = H.rec.get(id); if (r) { r.ids = []; r.disp = []; r.rtp = []; r.capRef = []; r.rtpRef = []; r.invalidos = 0; r.semCaptura = 0; } };
H.colher = (id) => H.rec.get(id);
H.stats = async (id) => {
  const rep = await H.pcs.get(id).getStats(); const out = {};
  rep.forEach((e) => {
    if (e.type === 'inbound-rtp' && e.kind === 'video') out.in = e;
    if (e.type === 'outbound-rtp' && e.kind === 'video') out.out = e;
    if (e.type === 'candidate-pair' && e.nominated) out.par = { rtt: e.currentRoundTripTime, avail: e.availableOutgoingBitrate, tipoLocal: e.localCandidateType };
  });
  return out;
};
// PLI de ponta a ponta: o filho pede, e medimos até o próximo quadro-chave decodificado.
H.testePli = async (id) => {
  const k0 = (await H.stats(id)).in?.keyFramesDecoded ?? 0; const t0 = performance.now();
  H.worker.postMessage({ tipo: 'pli', id });
  for (;;) {
    await new Promise((r) => setTimeout(r, 10));
    const k = (await H.stats(id)).in?.keyFramesDecoded ?? 0;
    if (k > k0) return performance.now() - t0;
    if (performance.now() - t0 > 6000) return null;
  }
};
</script>`;

// ───────────────────────── servidor local ─────────────────────────

const WEB_SRC = join(RAIZ, 'apps/web/src');
const servidor = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const enviar = (tipo, corpo) => { res.writeHead(200, { 'content-type': tipo }); res.end(corpo); };
  if (url.pathname === '/') return enviar('text/html', PAGINA);
  if (url.pathname === '/worker.js') return enviar('text/javascript', WORKER);
  if (url.pathname.startsWith('/src/') && url.pathname.endsWith('.js')) {
    const arq = join(WEB_SRC, url.pathname.slice(5).replace(/\.js$/, '.ts'));
    if (!arq.startsWith(WEB_SRC) || !existsSync(arq)) { res.writeHead(404); return res.end(); }
    const js = ts.transpileModule(readFileSync(arq, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return enviar('text/javascript', js.outputText);
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${servidor.address().port}`;

// ───────────────────────── processos e CPU ─────────────────────────

function arvoreDePids(raiz) {
  const todos = new Map();
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const s = readFileSync(`/proc/${p}/stat`, 'utf8');
      const cam = s.slice(s.lastIndexOf(')') + 2).split(' ');
      todos.set(Number(p), { ppid: Number(cam[1]), ticks: Number(cam[11]) + Number(cam[12]) });
    } catch { /* processo morreu */ }
  }
  const filhos = new Map();
  for (const [pid, v] of todos) (filhos.get(v.ppid) ?? filhos.set(v.ppid, []).get(v.ppid)).push(pid);
  const fila = [raiz]; let ticks = 0; let n = 0;
  while (fila.length) { const p = fila.pop(); const v = todos.get(p); if (v) { ticks += v.ticks; n += 1; } fila.push(...(filhos.get(p) ?? [])); }
  return { ticks, n };
}
const cpuNucleos = (a, b, s) => (b.ticks - a.ticks) / 100 / s;

class Papel {
  constructor(nome) { this.nome = nome; this.paginas = []; }
  async abrir() {
    this.srv = await chromium.launchServer({
      executablePath: CHROME, headless: true,
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    });
    this.pid = this.srv.process().pid;
    this.br = await chromium.connect(this.srv.wsEndpoint());
    return this;
  }
  async pagina(rotulo) {
    const ctx = await this.br.newContext(); const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log(`  [${this.nome}/${rotulo}] pageerror: ${e.message}`));
    await p.goto(BASE); await p.waitForFunction(() => window.H !== undefined);
    this.paginas.push(p); return p;
  }
  cpu() { return arvoreDePids(this.pid); }
  async fechar() { try { await this.br.close(); } catch { /* */ } try { await this.srv.close(); } catch { /* */ } }
}

async function ligar(emissor, receptor, id, opts) {
  const oferta = await emissor.evaluate((i) => window.H.enviarOferta(i), id);
  const resposta = await receptor.evaluate(([i, o, op]) => window.H.responder(i, o, op), [id, oferta, opts]);
  await emissor.evaluate(([i, a]) => window.H.aplicarResposta(i, a), [id, resposta]);
}
async function esperarQuadro(pagina, id, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await pagina.evaluate((i) => window.H.rec.get(i)?.primeiro ?? null, id);
    if (r !== null) return r;
    await esperar(50);
  }
  return null;
}
const FOR = (n) => Array.from({ length: n }, (_, i) => i);

// ───────────────────────── análise ─────────────────────────

function porId(rec) {
  const m = new Map();
  for (let i = 0; i < rec.ids.length; i++) if (!m.has(rec.ids[i])) m.set(rec.ids[i], { disp: rec.disp[i], rtp: rec.rtp[i], cap: rec.capRef[i], rtpRef: rec.rtpRef[i] });
  return m;
}
const NTP = 2_208_988_800_000;
function latCaptura(rec) {
  const out = [];
  for (let i = 0; i < rec.ids.length; i++) {
    if (rec.capRef[i] === null || rec.rtp[i] < 0) continue;
    const cap = rec.capRef[i] > 2.5e12 ? rec.capRef[i] - NTP : rec.capRef[i];
    const d = ((rec.rtp[i] - rec.rtpRef[i]) | 0) / 90;
    out.push(rec.disp[i] - (cap + d));
  }
  return out;
}
function resumoViewer(rec, t0map, janelaS) {
  const m = porId(rec); const lat = [];
  for (const [id, v] of m) { const t0 = t0map.get(id); if (t0 !== undefined) lat.push(v.disp - t0); }
  const ordem = [...m.entries()].sort((a, b) => a[0] - b[0]);
  const gaps = []; for (let i = 1; i < ordem.length; i++) gaps.push(ordem[i][1].disp - ordem[i - 1][1].disp);
  const ids = ordem.map((x) => x[0]);
  const esperados = ids.length ? ids[ids.length - 1] - ids[0] + 1 : 0;
  const lc = latCaptura(rec);
  return {
    quadros: m.size, fps: m.size / janelaS, pulados: esperados - m.size, invalidos: rec.invalidos,
    congel100: gaps.filter((g) => g > 100).length, congel200: gaps.filter((g) => g > 200).length, gapMax: Math.max(...gaps, 0),
    lat: { media: media(lat), med: med(lat), p95: pct(lat, 0.95), max: pct(lat, 1), n: lat.length },
    latCap: { media: media(lc), med: med(lc), p95: pct(lc, 0.95), max: pct(lc, 1), n: lc.length }, semCaptura: rec.semCaptura,
    w: rec.w, h: rec.h,
  };
}
function hop(recB, recA) {
  const b = porId(recB), a = porId(recA), d = [];
  for (const [id, v] of b) { const x = a.get(id); if (x) d.push(v.disp - x.disp); }
  return { media: media(d), med: med(d), p95: pct(d, 0.95), max: pct(d, 1), n: d.length };
}

// ───────────────────────── cenários ─────────────────────────

async function montar({ filhos, estrategia, idrMs, medirFilhos = true }) {
  const P = { host: await new Papel('host').abrir(), A: await new Papel('A').abrir(), R: await new Papel('R').abrir(), B: await new Papel('B').abrir() };
  const pg = {};
  pg.host = await P.host.pagina('host'); pg.A = await P.A.pagina('A'); pg.R = await P.R.pagina('R');
  pg.A2 = await P.B.pagina('A2');
  pg.B = []; for (const i of FOR(filhos)) pg.B.push(await P.B.pagina('B' + (i + 1)));
  for (const p of [pg.host, pg.A, pg.R, pg.A2, ...pg.B]) await p.evaluate(([j, mf]) => { window.H.jitterMs = j; window.H.maxfps = mf; }, [JITTER_MS, MAXFPS]);
  await pg.host.evaluate(([e]) => window.H.iniciarWorker('host', e[0], e[1], e[2]), [estrategia, TICK_HOST, TICK_HZ]);
  await pg.R.evaluate((e) => { window.H.iniciarWorker('relay', e[0], e[1], e[2]); window.H.criarIsca(); if (e[1] === 'livre') setInterval(() => window.H.isca.tique(), 1000 / e[2]); }, [estrategia, TICK_R, TICK_HZ]);
  for (const p of [pg.A, pg.A2, ...pg.B]) await p.evaluate(() => window.H.iniciarWorker('viewer', 'upstream'));
  await pg.host.evaluate((o) => window.H.hostIniciar(o), { idrMs, bitrate: BITRATE });
  await esperar(500);
  await ligar(pg.host, pg.A, 'hA', { medir: true, passa: true });
  await ligar(pg.host, pg.A2, 'hA2', { medir: true });
  await ligar(pg.host, pg.R, 'hR', { medir: MEDIR_R, relay: true });
  for (const [p, id] of [[pg.A, 'hA'], [pg.A2, 'hA2'], ...(MEDIR_R ? [[pg.R, 'hR']] : [])]) {
    if ((await esperarQuadro(p, id)) === null) throw new Error('sem imagem em ' + id);
  }
  if (!MEDIR_R) await esperar(1500);
  const joins = [];
  for (const i of FOR(filhos)) {
    const id = 'rB' + (i + 1); const t0 = Date.now();
    await ligar(pg.R, pg.B[i], id, { medir: medirFilhos, passa: true });
    const primeiro = await esperarQuadro(pg.B[i], id);
    joins.push(primeiro === null ? null : primeiro - (await pg.B[i].evaluate((x) => window.H.rec.get(x).criado, id)));
    void t0;
  }
  return { P, pg, joins };
}
async function desmontar({ P }) { for (const p of Object.values(P)) await p.fechar(); }

async function colherTudo(m, janelaS) {
  const { pg } = m;
  const host = await pg.host.evaluate(() => window.H.hostLog());
  const t0 = new Map(host.ids.map((id, i) => [id, host.t0[i]]));
  const rec = { A: await pg.A.evaluate(() => window.H.colher('hA')), A2: await pg.A2.evaluate(() => window.H.colher('hA2')), R: MEDIR_R ? await pg.R.evaluate(() => window.H.colher('hR')) : { ids: [], disp: [], rtp: [], capRef: [], rtpRef: [], invalidos: 0, semCaptura: 0, w: 0, h: 0 } };
  const B = []; for (const [i, p] of pg.B.entries()) B.push(await p.evaluate((x) => window.H.colher(x), 'rB' + (i + 1)));
  const r = {
    A: resumoViewer(rec.A, t0, janelaS), A2: resumoViewer(rec.A2, t0, janelaS), R: resumoViewer(rec.R, t0, janelaS),
    B: B.map((b) => resumoViewer(b, t0, janelaS)),
    hopBmenosA: B.map((b) => hop(b, rec.A)), hopBmenosA2: B.map((b) => hop(b, rec.A2)), hopRmenosA: hop(rec.R, rec.A), hopA2menosA: hop(rec.A2, rec.A),
  };
  return r;
}

async function cenarioLatencia1(filhos, estrategia, idrMs, seg = SEGUNDOS) {
  const calmo = await esperarCalma();
  const m = await montar({ filhos, estrategia, idrMs });
  await esperar(AQUECIMENTO_MS);
  const { pg, P } = m;
  const ids = [[pg.A, 'hA'], [pg.A2, 'hA2'], ...(MEDIR_R ? [[pg.R, 'hR']] : []), ...pg.B.map((p, i) => [p, 'rB' + (i + 1)])];
  for (const [p, id] of ids) await p.evaluate((x) => window.H.zerarMedida(x), id);
  await pg.R.evaluate(() => window.H.zerarWorker());
  await pg.host.evaluate(() => window.H.zerarWorker());
  const s0 = {}; for (const [k, v] of Object.entries(P)) s0[k] = v.cpu();
  const st0 = { A: (await pg.A.evaluate(() => window.H.stats('hA'))).in, R: (await pg.R.evaluate(() => window.H.stats('hR'))).in, B: await Promise.all(pg.B.map((p, i) => p.evaluate((x) => window.H.stats(x), 'rB' + (i + 1)))) };
  const tIni = Date.now(); const carga0 = loadavg();
  await esperar(seg * 1000);
  const dt = (Date.now() - tIni) / 1000;
  const cpu = {}; for (const [k, v] of Object.entries(P)) cpu[k] = cpuNucleos(s0[k], v.cpu(), dt);
  const st1 = { A: (await pg.A.evaluate(() => window.H.stats('hA'))).in, R: (await pg.R.evaluate(() => window.H.stats('hR'))).in, B: await Promise.all(pg.B.map((p, i) => p.evaluate((x) => window.H.stats(x), 'rB' + (i + 1)))) };
  const sw = { R: await pg.R.evaluate(() => window.H.statsWorker()), host: await pg.host.evaluate(() => window.H.statsWorker()) };
  const stOutR = await Promise.all(pg.B.map(() => null));
  void stOutR;
  const stOutHost = await pg.host.evaluate(() => window.H.stats('hR'));
  const r = await colherTudo(m, dt);
  const dec = (a, b) => ({ decodificados: b.framesDecoded - a.framesDecoded, fps: (b.framesDecoded - a.framesDecoded) / dt,
    chaves: b.keyFramesDecoded - a.keyFramesDecoded, perdidos: (b.packetsLost ?? 0) - (a.packetsLost ?? 0), descartados: (b.framesDropped ?? 0) - (a.framesDropped ?? 0),
    congelamentos: (b.freezeCount ?? 0) - (a.freezeCount ?? 0), pli: (b.pliCount ?? 0) - (a.pliCount ?? 0),
    jitterBufMs: 1000 * (b.jitterBufferDelay - a.jitterBufferDelay) / Math.max(1, b.jitterBufferEmittedCount - a.jitterBufferEmittedCount),
    decoder: b.decoderImplementation, kbps: ((b.bytesReceived - a.bytesReceived) * 8) / dt / 1000 });
  r.decodificacao = { A: dec(st0.A, st1.A), R: dec(st0.R, st1.R), B: st1.B.map((b, i) => dec(st0.B[i].in, b.in)) };
  r.cpu = cpu; r.worker = sw; r.carga = { antes: carga0, depois: loadavg() }; r.janelaS = dt;
  r.joinMs = m.joins;
  r.contaminada = !calmo || Math.max(...carga0.slice(0, 1)) > CARGA_MAX * 1.5 || loadavg()[0] > 12;
  r.hostEnviaParaR = { chaves: stOutHost.out?.keyFramesEncoded, pli: stOutHost.out?.pliCount };
  r.erros = { R: await pg.R.evaluate(() => window.H.erros), host: await pg.host.evaluate(() => window.H.erros) };
  await desmontar(m);
  return r;
}

async function cenarioLatencia(filhos, estrategia, idrMs, seg = SEGUNDOS) {
  let r;
  for (let t = 1; t <= 4; t++) {
    r = await cenarioLatencia1(filhos, estrategia, idrMs, seg);
    if (!r.contaminada) break;
    console.log(`  (rodada contaminada por carga externa: loadavg ${r.carga.antes.map((x) => f(x, 1)).join('/')} → ${r.carga.depois.map((x) => f(x, 1)).join('/')}; repetindo, tentativa ${t}/4)`);
  }
  return r;
}

function imprimirLatencia(titulo, r) {
  console.log(`\n--- ${titulo} (janela ${f(r.janelaS, 0)} s${r.contaminada ? ', CONTAMINADA' : ''}, loadavg ${r.carga.antes.map((x) => f(x, 2)).join('/')} → ${r.carga.depois.map((x) => f(x, 2)).join('/')}) ---`);
  const lin = (nome, v) => console.log(`  ${nome.padEnd(4)} id-lat média ${f(v.lat.media)} med ${f(v.lat.med)} p95 ${f(v.lat.p95)} max ${f(v.lat.max)} ms | carimbo média ${f(v.latCap.media)} med ${f(v.latCap.med)} p95 ${f(v.latCap.p95)} (sem carimbo ${v.semCaptura}) | ${f(v.fps, 1)} fps, pulados ${v.pulados}, inválidos ${v.invalidos}, gaps>100ms ${v.congel100} (>200ms ${v.congel200}), gapMax ${f(v.gapMax, 0)} | ${v.w}x${v.h}`);
  lin('A', r.A); lin('A2', r.A2); lin('R', r.R);
  r.B.forEach((b, i) => lin('B' + (i + 1), b));
  console.log(`  A2−A (ruído de fase entre navegadores): média ${f(r.hopA2menosA.media)} med ${f(r.hopA2menosA.med)} p95 ${f(r.hopA2menosA.p95)} | R−A: média ${f(r.hopRmenosA.media)} med ${f(r.hopRmenosA.med)}`);
  r.hopBmenosA.forEach((h, i) => console.log(`  B${i + 1}−A  média ${f(h.media)} med ${f(h.med)} p95 ${f(h.p95)} max ${f(h.max)} (n=${h.n}) | B${i + 1}−A2 média ${f(r.hopBmenosA2[i].media)} med ${f(r.hopBmenosA2[i].med)} p95 ${f(r.hopBmenosA2[i].p95)} max ${f(r.hopBmenosA2[i].max)}`));
  console.log(`  decodif.: A ${f(r.decodificacao.A.fps)} fps chaves ${r.decodificacao.A.chaves} | R ${f(r.decodificacao.R.fps)} fps chaves ${r.decodificacao.R.chaves} | B ${r.decodificacao.B.map((b) => `${f(b.fps)}fps/chaves ${b.chaves}/frz ${b.congelamentos}/perda ${b.perdidos}/jb ${f(b.jitterBufMs, 0)}ms`).join(' ; ')}`);
  console.log(`  CPU (núcleos): host ${f(r.cpu.host, 2)} A ${f(r.cpu.A, 2)} R ${f(r.cpu.R, 2)} B(${r.B.length + 1} pgs) ${f(r.cpu.B, 2)}`);
  const w = r.worker.R;
  console.log(`  R: recebidos ${w.recebidos} (chaves ${w.chavesRecebidas}), injetados ${w.injetados} de ${w.slots} vagas de isca, cópia ${f(w.msCopia.p50, 3)}/${f(w.msCopia.p95, 3)} ms (p50/p95), chegada→isca ${f(w.latFila.p50, 2)}/${f(w.latFila.p95, 2)}/${f(w.latFila.max, 1)} ms, pedidos acima ${w.pedidosAcima} (feitos ${w.pedidosAcimaFeitos}), replays ${w.replays}`);
  console.log(`  join dos filhos (ms até 1º quadro): ${r.joinMs.map((x) => f(x, 0)).join(', ')} | metadata recepção: ${JSON.stringify(w.metaReceber)} | isca: ${JSON.stringify(w.metaIsca)} | setMetadata ${w.temSetMetadata} sendKeyFrameRequest ${w.temSendKeyFrameRequest}`);
  if (r.erros.R.length || r.erros.host.length) console.log(`  ERROS: ${JSON.stringify(r.erros)}`);
}

async function cenarioChave(estrategia, idrMs, entradas = 5) {
  await esperarCalma();
  const m = await montar({ filhos: 0, estrategia, idrMs });
  await esperar(6000);
  const { pg, P } = m; const res = { entradas: [], pliB: [], pliA: [], latPosEntrada: [] };
  const ext = await P.B.pagina('Bx'); await ext.evaluate((e) => window.H.iniciarWorker('viewer', e), 'upstream'); await ext.evaluate((j) => { window.H.jitterMs = j; }, JITTER_MS);
  await pg.R.evaluate(() => window.H.zerarWorker());
  for (const i of FOR(entradas)) {
    await esperar(700 + Math.floor(Math.random() * 1500));   // deslocamento aleatório dentro do ciclo de IDR
    const id = 'rJ' + i;
    await ligar(pg.R, ext, id, { medir: true, passa: true });
    const primeiro = await esperarQuadro(ext, id, 12000);
    const criado = await ext.evaluate((x) => window.H.rec.get(x).criado, id);
    res.entradas.push(primeiro === null ? null : primeiro - criado);
    if (primeiro !== null) {
      // Depois da entrada: o filho ficou atrasado em relação ao anfitrião? (a rajada do cache pode deixá-lo para trás)
      await esperar(2500);
      await ext.evaluate((x) => window.H.zerarMedida(x), id); await pg.A.evaluate(() => window.H.zerarMedida('hA'));
      await esperar(2000);
      const hl = await pg.host.evaluate(() => window.H.hostLog()); const t0m = new Map(hl.ids.map((q, j) => [q, hl.t0[j]]));
      const lp = async (p, x) => { const r = await p.evaluate((y) => window.H.colher(y), x); return media(r.ids.map((q, j) => (t0m.has(q) ? r.disp[j] - t0m.get(q) : NaN))); };
      res.latPosEntrada.push({ filho: await lp(ext, id), A: await lp(pg.A, 'hA') });
      res.pliB.push(await ext.evaluate((x) => window.H.testePli(x), id));
    }
    await ext.evaluate((x) => window.H.fechar(x), id);
    await pg.R.evaluate((x) => window.H.fechar(x), id);
    await esperar(300);
  }
  // controle: PLI pedido pelo espectador direto
  for (const i of FOR(3)) { res.pliA.push(await pg.A.evaluate(() => window.H.testePli('hA'))); await esperar(1500); }
  res.worker = await pg.R.evaluate(() => window.H.statsWorker());
  res.hostWorker = await pg.host.evaluate(() => window.H.statsWorker());
  res.hostChavesParaA = (await pg.host.evaluate(() => window.H.stats('hA'))).out?.keyFramesEncoded;
  await desmontar(m);
  return res;
}

// ───────────────────────── main ─────────────────────────

const maq = { cpu: cpus()[0]?.model, nucleos: cpus().length, ramGiB: Math.round(totalmem() / 2 ** 30), chrome: spawnSync(CHROME, ['--version']).stdout.toString().trim(), loadavgInicio: loadavg() };
console.log('E2 — repasse sem recodificar. Máquina:', JSON.stringify(maq));
const TODOS = { cenarios: CENARIOS, SEGUNDOS, RUNS, BITRATE, JITTER_MS, TICK_R, TICK_HOST, TICK_HZ, MAXFPS, MEDIR_R, ESTRATEGIA, IDR_MS };
const saida = { maq, cfg: TODOS, latencia: [], filhos: [], chave: [] };

const TICKS = String(args.ticks ?? 'chegada,livre').split(',');
if (CENARIOS.includes('latencia')) {
  for (const tk of TICKS) {
    TICK_R = tk;
    for (let i = 1; i <= RUNS; i++) {
      const r = await cenarioLatencia(1, 'upstream', 0);
      saida.latencia.push({ tick: tk, ...r }); imprimirLatencia(`latência, 1 filho, tick ${tk}, run ${i}/${RUNS}`, r);
    }
  }
}
if (CENARIOS.includes('filhos')) {
  for (const tk of TICKS) {
    TICK_R = tk;
    const r0 = await cenarioLatencia(0, ESTRATEGIA, IDR_MS, Math.min(SEGUNDOS, 40));
    saida.filhos.push({ tick: tk, k: 0, r: r0 }); imprimirLatencia(`custo: R com transform e 0 filhos, tick ${tk}`, r0);
    for (const k of FILHOS) {
      const r = await cenarioLatencia(k, ESTRATEGIA, IDR_MS, Math.min(SEGUNDOS, 40));
      saida.filhos.push({ tick: tk, k, r }); imprimirLatencia(`custo: R com ${k} filho(s), tick ${tk}`, r);
    }
  }
}
if (CENARIOS.includes('chave')) {
  TICK_R = String(args.tickchave ?? 'livre');
  for (const [estrategia, idrMs] of [['upstream', 0], ['upstream', 1000], ['cache', 1000]]) {
    for (let i = 1; i <= Math.min(RUNS, 3); i++) {
      const r = await cenarioChave(estrategia, idrMs);
      saida.chave.push({ estrategia, idrMs, ...r });
      const w = r.worker;
      console.log(`\n--- chave: estratégia ${estrategia}, IDR periódico ${idrMs || 'não'} ms, run ${i} ---`);
      console.log(`  entrada de filho em R (ms até 1º quadro): ${r.entradas.map((x) => f(x, 0)).join(', ')} | med ${f(med(r.entradas), 0)}`);
      console.log(`  latência 2,5–4,5 s após a entrada (média, ms): filho ${r.latPosEntrada.map((x) => f(x.filho, 0)).join(', ')} | A no mesmo instante ${r.latPosEntrada.map((x) => f(x.A, 0)).join(', ')}`);
      console.log(`  PLI do filho B → chave decodificada em B (ms): ${r.pliB.map((x) => f(x, 0)).join(', ')} | PLI do A direto: ${r.pliA.map((x) => f(x, 0)).join(', ')}`);
      console.log(`  R: pedidos acima ${w.pedidosAcima} (feitos ${w.pedidosAcimaFeitos}), replays do cache ${w.replays}, chaves recebidas ${w.chavesRecebidas}, injetadas ${w.chavesInjetadas}, quadros ${w.recebidos}/${w.injetados} | host: chaves para A ${r.hostChavesParaA}`);
    }
  }
}
console.log('\nJSON ' + JSON.stringify(saida));
servidor.close();
process.exit(0);
