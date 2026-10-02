/**
 * Estudo do codec (docs/engenharia/estudo/1-codec.md, §1): intra refresh
 * periódico no lugar do IDR sob demanda.
 *
 * Parte A (NVENC real, via ffmpeg `h264_nvenc`; precisa de GPU NVIDIA):
 *   gera 1080p60 sintético (mandelbrot), CBR com VBV de 4 quadros, e compara o
 *   tamanho do maior quadro com IDR forçado vs intra refresh (-intra-refresh 1,
 *   período = -g). Mesmos parâmetros do `tela-captura.c` (p4, ull, zerolatency,
 *   spatial-aq, bframes=0, baseline).
 *
 * Parte B (Chromium headless, decoder de software): quem ENTRA no meio de um
 *   fluxo sem IDR consegue decodificar? Corta o fluxo (a) num quadro com SEI de
 *   recovery point, (b) num P qualquer, e alimenta o `VideoDecoder` com o
 *   primeiro chunk marcado 'key' (único jeito de o WebCodecs aceitar), e (c)
 *   num P marcado 'delta'. Compara cada quadro de saída, por timestamp, com a
 *   decodificação do fluxo inteiro.
 *
 *   node e2e/bench/estudo-intra-refresh.mjs [--segundos=4] [--so=A|B]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a); return [m[1], m[2] === '' ? true : m[2]]; }));
const SEG = Number(args['segundos'] ?? 4);
const dir = mkdtempSync(join(tmpdir(), 'ir-'));

/** Renderiza a fonte uma vez, sem perdas: o lavfi `mandelbrot` roda a ~17 q/s e travaria o encoder. */
function fonte() {
  const arq = join(tmpdir(), `tela-estudo-fontes`, `mandelbrot-${SEG}s.mkv`);
  if (!existsSync(arq)) {
    spawnSync('mkdir', ['-p', join(tmpdir(), 'tela-estudo-fontes')]);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'mandelbrot=s=1920x1080:r=60:end_scale=0.01,format=yuv420p', '-t', String(SEG), '-c:v', 'ffv1', '-level', '3', '-g', '1', arq], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  return arq;
}

function gerar(nome, extra, mbps = 12, vbvQuadros = 4) {
  const arq = join(dir, `${nome}.h264`);
  const vbv = Math.round((mbps * 1000 / 60) * vbvQuadros);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', fonte(),
    '-c:v', 'h264_nvenc', '-profile:v', 'baseline', '-preset', 'p4', '-tune', 'ull', '-rc', 'cbr', '-b:v', `${mbps}M`, '-maxrate', `${mbps}M`, '-bufsize', `${vbv}k`,
    '-bf', '0', '-zerolatency', '1', '-spatial-aq', '1', '-forced-idr', '1', ...extra, '-f', 'h264', arq], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg falhou (${nome}): ${r.stderr.slice(0, 300)}`);
  return arq;
}

/** Separa o Annex B em access units. Devolve [{ini, fim, tipos:[nal types], recovery:boolean, idr:boolean}] */
function aus(buf) {
  const nals = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      const ini = i > 0 && buf[i - 1] === 0 ? i - 1 : i;
      nals.push({ ini, tipo: buf[i + 3] & 0x1f, sei: (buf[i + 3] & 0x1f) === 6 ? buf[i + 4] : -1, primeiro: (buf[i + 4] & 0x80) !== 0 });
      i += 2;
    }
  }
  const out = [];
  let atual = null;
  let vcl = false;
  for (const n of nals) {
    const novo = atual === null || (vcl && (n.tipo === 6 || n.tipo === 7 || n.tipo === 8 || n.tipo === 9 || ((n.tipo === 1 || n.tipo === 5) && n.primeiro)));
    if (novo) {
      if (atual) out.push(atual);
      atual = { ini: n.ini, fim: 0, tipos: [], recovery: false, idr: false };
      vcl = false;
    }
    atual.tipos.push(n.tipo);
    if (n.tipo === 6 && n.sei === 6) atual.recovery = true;
    if (n.tipo === 5) atual.idr = true;
    if (n.tipo === 1 || n.tipo === 5) vcl = true;
  }
  if (atual) out.push(atual);
  out.forEach((a, i) => { a.fim = i + 1 < out.length ? out[i + 1].ini : buf.length; });
  return out;
}

function parteA() {
  console.log(`\n## A. Tamanho do maior quadro, NVENC real (1080p60, ${SEG} s, CBR, VBV 4 quadros)`);
  console.log('| Mbps | modo | média KB | maior quadro (exceto o 1º) KB | maior/média |');
  console.log('|---|---|---|---|---|');
  for (const mbps of [6, 12, 30, 60]) {
    for (const [nome, extra] of [['IDR forçado @1,5 s', ['-g', '100000', '-force_key_frames', '1.5']], ['intra refresh g=60', ['-g', '60', '-intra-refresh', '1']], ['intra refresh g=30', ['-g', '30', '-intra-refresh', '1']]]) {
      const arq = gerar(`a-${mbps}-${nome.replace(/\W+/g, '')}`, extra, mbps);
      const buf = readFileSync(arq);
      const todas = aus(buf).map((a) => a.fim - a.ini);
      const resto = todas.slice(1);
      const media = todas.reduce((s, x) => s + x, 0) / todas.length;
      const maior = Math.max(...resto);
      console.log(`| ${mbps} | ${nome} | ${(media / 1024).toFixed(1)} | ${(maior / 1024).toFixed(1)} | ${(maior / media).toFixed(2)} |`);
    }
  }
}

async function parteB() {
  console.log(`\n## B. Entrar no meio do fluxo (Chromium headless, decoder de software)`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.goto((process.env.WEB_URL ?? 'http://localhost:5173') + '/@@bench', { waitUntil: 'domcontentloaded' }); // contexto seguro: WebCodecs
  for (const [nome, extra] of [['intra refresh g=60', ['-g', '60', '-intra-refresh', '1']], ['intra refresh g=30', ['-g', '30', '-intra-refresh', '1']], ['IDR só no início', ['-g', '100000']]]) {
    const arq = gerar(`b-${nome.replace(/\W+/g, '')}`, extra);
    const buf = readFileSync(arq);
    const lista = aus(buf);
    const recs = lista.map((a, i) => (a.recovery ? i : -1)).filter((i) => i > 0);
    const cabecalho = buf.subarray(lista[0].ini, lista[0].ini + 0); // preenchido abaixo
    // SPS+PPS = NALs 7 e 8 do primeiro AU
    const idxIdr = lista[0].tipos.indexOf(5);
    void cabecalho; void idxIdr;
    // prefixo = bytes do primeiro AU até o primeiro SEI/IDR (7,8)
    let fimPs = lista[0].ini;
    for (let i = lista[0].ini; i + 3 < buf.length; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1 && ((buf[i + 3] & 0x1f) === 6 || (buf[i + 3] & 0x1f) === 5)) { fimPs = i > 0 && buf[i - 1] === 0 ? i - 1 : i; break; }
    }
    const casos = [];
    const rec = recs[0];
    if (rec !== undefined) casos.push({ rotulo: `no quadro com SEI recovery point (#${rec}), chunk 'key'`, ini: rec, tipo: 'key' });
    const p = (rec ?? 60) + 17;
    casos.push({ rotulo: `num P qualquer (#${p}), chunk 'key'`, ini: p, tipo: 'key' });
    casos.push({ rotulo: `num P qualquer (#${p}), chunk 'delta'`, ini: p, tipo: 'delta' });
    casos.push({ rotulo: `no IDR (#0), controle`, ini: 0, tipo: 'key' });
    const r = await page.evaluate(
      async ({ b64, lista, fimPs, casos }) => {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const prefixo = bin.subarray(lista[0].ini, fimPs);
        const W = 1920, H = 1080, DT = 16667;
        async function decodificar(ini, tipoPrimeiro) {
          const saidas = new Map();
          let erro = null;
          const dec = new VideoDecoder({
            output: (f) => {
              const ts = f.timestamp;
              saidas.set(ts, { f });
            },
            error: (e) => { erro = String(e); },
          });
          dec.configure({ codec: 'avc1.42c02a', codedWidth: W, codedHeight: H, hardwareAcceleration: 'prefer-software' });
          for (let i = ini; i < lista.length; i++) {
            const a = lista[i];
            let dados = bin.subarray(a.ini, a.fim);
            if (i === ini && ini !== 0) { const x = new Uint8Array(prefixo.length + dados.length); x.set(prefixo); x.set(dados, prefixo.length); dados = x; }
            const tipo = i === ini ? tipoPrimeiro : lista[i].idr ? 'key' : 'delta';
            try { dec.decode(new EncodedVideoChunk({ type: tipo, timestamp: i * DT, data: dados })); } catch (e) { erro = String(e); break; }
          }
          try { await dec.flush(); } catch (e) { erro = erro ?? String(e); }
          // copia luma de cada saída (assíncrono acima não garante); refaz de forma síncrona-await
          const mapa = new Map();
          for (const [ts, { f }] of saidas) {
            const luma = new Uint8Array(W * H);
            try { await f.copyTo(luma, { rect: { x: 0, y: 0, width: W, height: H }, layout: [{ offset: 0, stride: W }] }); } catch { /* formato */ }
            mapa.set(ts, luma);
            f.close();
          }
          try { dec.close(); } catch { /* já fechado */ }
          return { mapa, erro };
        }
        const ref = await decodificar(0, 'key');
        const res = [];
        for (const c of casos) {
          const { mapa, erro } = await decodificar(c.ini, c.tipo);
          const tss = [...mapa.keys()].sort((a, b) => a - b);
          const linhas = [];
          let primeiroLimpo = null;
          let limposDesdeAqui = 0;
          for (const ts of tss) {
            const i = Math.round(ts / DT);
            const a = mapa.get(ts), b = ref.mapa.get(ts);
            if (!b) continue;
            let soma = 0; const passo = 7;
            let n = 0;
            for (let k = 0; k < a.length; k += passo) { soma += Math.abs(a[k] - b[k]); n++; }
            const mad = soma / n;
            linhas.push([i - c.ini, +mad.toFixed(2)]);
          }
          // primeiro quadro a partir do qual TODOS os seguintes têm MAD < 0,5
          for (let k = linhas.length - 1; k >= 0; k--) { if (linhas[k][1] < 0.5) limposDesdeAqui = linhas[k][0]; else break; }
          primeiroLimpo = linhas.length ? limposDesdeAqui : null;
          res.push({ rotulo: c.rotulo, saidas: tss.length, primeiroOffset: tss.length ? Math.round(tss[0] / DT) - c.ini : null, limpoApos: primeiroLimpo, mad10: linhas.slice(0, 10), erro });
        }
        return { refSaidas: ref.mapa.size, refErro: ref.erro, res };
      },
      { b64: buf.toString('base64'), lista: lista.map((a) => ({ ini: a.ini, fim: a.fim, idr: a.idr, recovery: a.recovery })), fimPs, casos },
    );
    console.log(`\n### ${nome} (${(statSync(arq).size / 1e6).toFixed(1)} MB, ${lista.length} AUs, SEI recovery nos AUs: ${recs.slice(0, 6).join(', ') || 'nenhum'}) — referência decodificou ${r.refSaidas} quadros${r.refErro ? ' erro ' + r.refErro : ''}`);
    for (const x of r.res) console.log(`- ${x.rotulo}: ${x.saidas} quadros de saída${x.erro ? `, ERRO ${x.erro}` : ''}; 1ª saída em +${x.primeiroOffset}; limpo (MAD<0,5 em todos dali em diante) a partir de +${x.limpoApos} quadros; MAD dos 10 primeiros [offset, MAD]: ${JSON.stringify(x.mad10)}`);
  }
  await browser.close();
}

if (args['so'] !== 'B') parteA();
if (args['so'] !== 'A') await parteB();
