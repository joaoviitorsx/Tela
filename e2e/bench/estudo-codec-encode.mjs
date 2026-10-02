/**
 * Estudo do codec (docs/engenharia/estudo/1-codec.md, §6b): codifica uma
 * sequência sintética de movimento alto, 1080p60, com WebCodecs em software
 * (Chromium headless não tem GPU), para vários codecs, e mede:
 *
 *   - tempo de parede por quadro (encode + flush, quadros já gerados);
 *   - bytes por quadro-chave e por quadro P, e bitrate efetivo vs alvo;
 *   - PSNR de luma contra a fonte (decodificando com VideoDecoder de software);
 *   - metadados de camada temporal (`svc.temporalLayerId`) e se o fluxo só com
 *     a camada-base decodifica (adaptação por espectador sem outro encoder).
 *
 * LIMITES: software, sem GPU, máquina de desenvolvimento, 60 quadros por
 * rodada, conteúdo sintético (rolagem de textura + sprites + HUD). Serve para
 * ordem de grandeza e para o que o navegador ACEITA, não como veredicto de
 * qualidade de jogo real. Para hardware, rodar no Electron do app (ver
 * estudo-webcodecs-matriz.mjs) em máquina com GPU.
 *
 *   pnpm dev   (noutro terminal; só para ter um contexto seguro)
 *   node e2e/bench/estudo-codec-encode.mjs [--mbps=12] [--quadros=60] [--so=avc1,vp09] [--bm=variable|constant]
 */
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a); return [m[1], m[2] === '' ? true : m[2]]; }));
const MBPS = Number(args['mbps'] ?? 12);
const QUADROS = Number(args['quadros'] ?? 60);
const BM = typeof args['bm'] === 'string' ? args['bm'] : 'variable';
const SO = typeof args['so'] === 'string' ? args['so'].split(',') : null;

async function rodar() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(100_000);
  await page.goto(`${WEB}/@@bench`, { waitUntil: 'domcontentloaded' });

  const casos = [
    { nome: 'H.264 CBP (avc1.42e02a) L1T1', codec: 'avc1.42e02a', extra: { avc: { format: 'annexb' } } },
    { nome: 'H.264 CBP L1T2', codec: 'avc1.42e02a', svc: 'L1T2', extra: { avc: { format: 'annexb' } } },
    { nome: 'H.264 CBP L1T3', codec: 'avc1.42e02a', svc: 'L1T3', extra: { avc: { format: 'annexb' } } },
    { nome: 'H.264 High (avc1.640028)', codec: 'avc1.640028', extra: { avc: { format: 'annexb' } } },
    { nome: 'VP8', codec: 'vp8' },
    { nome: 'VP9 p0 L1T1', codec: 'vp09.00.41.08' },
    { nome: 'VP9 p0 L1T3', codec: 'vp09.00.41.08', svc: 'L1T3' },
    { nome: 'AV1 (av01.0.08M.08)', codec: 'av01.0.08M.08' },
    { nome: 'AV1 L1T3', codec: 'av01.0.08M.08', svc: 'L1T3' },
  ].filter((c) => SO === null || SO.some((s) => c.codec.startsWith(s)));

  await page.evaluate(
    async ({ quadros }) => {
      const W = 1920, H = 1080;
      const gerar = () => {
        // textura 2W x H: círculos, linhas e "folhas" aleatórias determinísticas
        let s = 12345;
        const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
        const tex = new OffscreenCanvas(W * 2, H);
        const t = tex.getContext('2d');
        const g = t.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#2a3f5f'); g.addColorStop(0.5, '#6b8e4e'); g.addColorStop(1, '#3b2f2f');
        t.fillStyle = g; t.fillRect(0, 0, W * 2, H);
        for (let i = 0; i < 6000; i++) {
          t.fillStyle = `hsla(${Math.floor(rnd() * 360)},${30 + rnd() * 50}%,${20 + rnd() * 60}%,${0.3 + rnd() * 0.6})`;
          t.beginPath(); t.arc(rnd() * W * 2, rnd() * H, 2 + rnd() * 22, 0, 6.3); t.fill();
        }
        for (let i = 0; i < 2500; i++) {
          t.strokeStyle = `rgba(${rnd() * 255 | 0},${rnd() * 255 | 0},${rnd() * 255 | 0},0.7)`;
          t.lineWidth = 1 + rnd() * 3; t.beginPath(); t.moveTo(rnd() * W * 2, rnd() * H); t.lineTo(rnd() * W * 2, rnd() * H); t.stroke();
        }
        const c = new OffscreenCanvas(W, H);
        const x = c.getContext('2d');
        const frames = [];
        for (let i = 0; i < quadros; i++) {
          x.drawImage(tex, -((i * 11) % W), 0); x.drawImage(tex, W - ((i * 11) % W), 0); // fundo: 11 px/quadro
          x.globalAlpha = 0.55; x.drawImage(tex, -((i * 23) % W), 40, W * 2, H, 0, 0, W * 2, H); x.globalAlpha = 1; // parallax mais rápido
          for (let k = 0; k < 8; k++) { // sprites girando
            x.save(); x.translate(300 + k * 200 + 80 * Math.sin(i / 7 + k), 540 + 300 * Math.cos(i / 9 + k * 2)); x.rotate(i / 5 + k);
            x.fillStyle = k % 2 ? '#ffd24a' : '#e5484d'; x.fillRect(-45, -45, 90, 90); x.restore();
          }
          x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillRect(40, 40, 420, 120); x.fillStyle = '#fff'; x.font = '64px monospace'; x.fillText(`HP ${100 - (i >> 2)}  K ${i % 10}`, 60, 120); // HUD (quase estático)
          const rgba = x.getImageData(0, 0, W, H).data;
          const i420 = new Uint8Array(W * H * 3 / 2);
          const yy = W * H, cw = W / 2;
          for (let r = 0; r < H; r++) {
            for (let q = 0; q < W; q++) {
              const o = (r * W + q) * 4;
              const R = rgba[o], G = rgba[o + 1], B = rgba[o + 2];
              i420[r * W + q] = 16 + ((66 * R + 129 * G + 25 * B + 128) >> 8);
              if ((r & 1) === 0 && (q & 1) === 0) {
                const ci = (r >> 1) * cw + (q >> 1);
                i420[yy + ci] = 128 + ((-38 * R - 74 * G + 112 * B + 128) >> 8);
                i420[yy + yy / 4 + ci] = 128 + ((112 * R - 94 * G - 18 * B + 128) >> 8);
              }
            }
          }
          frames.push(new VideoFrame(i420, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: Math.round(i * 1e6 / 60) }));
        }
        return frames;
      };
      window.__frames = gerar();
      window.__luma = [];
      for (const f of window.__frames) {
        const buf = new Uint8Array(f.allocationSize());
        await f.copyTo(buf);
        window.__luma.push(buf.subarray(0, W * H));
      }
    },
    { quadros: QUADROS },
  );

  const bps = MBPS * 1e6;
  console.log(`# Codificação sintética 1920x1080@60, ${QUADROS} quadros, alvo ${MBPS} Mbps, bitrateMode ${BM} (${(bps / (1920 * 1080 * 60)).toFixed(3)} bpp), latencyMode realtime, prefer-software\n`);
  console.log('| configuração | suportado | ms/quadro (parede) | fps máx | KB quadro-chave | KB P médio | Mbps efetivo | PSNR luma dB (média / mín) | camadas T (contagem) | só camada-base decodifica |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of casos) {
    const r = await page.evaluate(
      async ({ c, bps, quadros, bm }) => {
        const W = 1920, H = 1080;
        const cfg = { codec: c.codec, width: W, height: H, bitrate: bps, framerate: 60, latencyMode: 'realtime', bitrateMode: bm, hardwareAcceleration: 'prefer-software', ...(c.extra ?? {}) };
        if (c.svc) cfg.scalabilityMode = c.svc;
        let sup;
        try { sup = (await VideoEncoder.isConfigSupported(cfg)).supported; } catch (e) { return { erro: 'isConfigSupported ' + e.name }; }
        if (!sup) return { suportado: false };
        const saidas = [];
        let erro = null;
        const enc = new VideoEncoder({ output: (chunk, meta) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); saidas.push({ ts: chunk.timestamp, tipo: chunk.type, d, t: meta?.svc?.temporalLayerId ?? null, desc: meta?.decoderConfig ? { ...meta.decoderConfig, description: undefined } : null }); }, error: (e) => { erro = String(e); } });
        enc.configure(cfg);
        const frames = window.__frames;
        const t0 = performance.now();
        for (let i = 0; i < frames.length; i++) {
          enc.encode(frames[i], { keyFrame: i === 0 });
          // contrapressão: não deixa a fila crescer sem fim (não mede latência, mede vazão)
          while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));
        }
        await enc.flush();
        const dt = performance.now() - t0;
        enc.close();
        if (erro) return { erro };
        const chaves = saidas.filter((s) => s.tipo === 'key');
        const ps = saidas.filter((s) => s.tipo !== 'key');
        const total = saidas.reduce((s, x) => s + x.d.length, 0);
        const refIdc = {};
        if (c.codec.startsWith('avc1')) {
          for (const sd of saidas) {
            const d = sd.d;
            for (let k = 0; k + 4 < d.length; k++) {
              if (d[k] === 0 && d[k + 1] === 0 && d[k + 2] === 1 && ((d[k + 3] & 0x1f) === 1 || (d[k + 3] & 0x1f) === 5)) {
                const key = `T${sd.t ?? '-'}:ref_idc=${(d[k + 3] >> 5) & 3}`;
                refIdc[key] = (refIdc[key] ?? 0) + 1;
                break;
              }
            }
          }
        }
        const camadas = {};
        for (const s of saidas) camadas[s.t ?? 'n/d'] = (camadas[s.t ?? 'n/d'] ?? 0) + 1;
        const bytesCamada = {};
        for (const s of saidas) bytesCamada[s.t ?? 'n/d'] = (bytesCamada[s.t ?? 'n/d'] ?? 0) + s.d.length;
        for (const k of Object.keys(bytesCamada)) bytesCamada[k] = +(100 * bytesCamada[k] / total).toFixed(0);

        async function decodificar(lista) {
          const out = new Map();
          let e2 = null;
          const dec = new VideoDecoder({ output: async (f) => { out.set(f.timestamp, f); }, error: (e) => { e2 = String(e); } });
          const dc = { codec: c.codec, codedWidth: W, codedHeight: H, hardwareAcceleration: 'prefer-software' };
          dec.configure(dc);
          for (const s of lista) {
            try { dec.decode(new EncodedVideoChunk({ type: s.tipo, timestamp: s.ts, data: s.d })); } catch (e) { e2 = String(e); break; }
          }
          try { await dec.flush(); } catch (e) { e2 = e2 ?? String(e); }
          return { out, erro: e2 };
        }
        async function psnr(out) {
          let soma = 0, n = 0, min = 99;
          const hashes = new Map();
          for (const [ts, f] of out) {
            const i = Math.round(ts * 60 / 1e6);
            const buf = new Uint8Array(f.allocationSize());
            await f.copyTo(buf);
            f.close();
            const a = buf, b = window.__luma[i];
            let h = 2166136261;
            for (let k = 0; k < W * H; k += 5) h = Math.imul(h ^ a[k], 16777619) >>> 0;
            hashes.set(ts, h);
            let se = 0;
            for (let k = 0; k < W * H; k += 3) { const d = a[k] - b[k]; se += d * d; }
            const mse = se / (W * H / 3);
            const p = mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse);
            soma += p; n++; min = Math.min(min, p);
          }
          return { media: n ? soma / n : null, min: n ? min : null, n, hashes };
        }
        const dec = await decodificar(saidas);
        const q = await psnr(dec.out);
        let base = null;
        if (c.svc) {
          const so0 = saidas.filter((s) => (s.t ?? 0) === 0 || s.tipo === 'key');
          const d0 = await decodificar(so0);
          base = { enviados: so0.length, decodificados: d0.out.size, erro: d0.erro };
          const q0 = await psnr(d0.out);
          let iguais = 0;
          for (const [ts, h] of q0.hashes) if (q.hashes.get(ts) === h) iguais++;
          base.identicosAoFluxoCompleto = iguais;
        }
        return {
          suportado: true,
          msQuadro: dt / frames.length,
          chaveKB: chaves.length ? chaves[0].d.length / 1024 : null,
          pKB: ps.length ? ps.reduce((s, x) => s + x.d.length, 0) / ps.length / 1024 : null,
          mbps: (total * 8 * 60) / frames.length / 1e6,
          psnr: q,
          camadas,
          bytesCamada,
          refIdc,
          base,
          erroDec: dec.erro,
        };
      },
      { c, bps, quadros: QUADROS, bm: BM },
    ).catch((e) => ({ erro: String(e).slice(0, 120) }));
    if (r.erro) console.log(`| ${c.nome} | erro | ${r.erro} |||||||| `);
    else if (!r.suportado) console.log(`| ${c.nome} | não | | | | | | | | |`);
    else
      console.log(
        `| ${c.nome} | sim | ${r.msQuadro.toFixed(1)} | ${(1000 / r.msQuadro).toFixed(0)} | ${r.chaveKB?.toFixed(0) ?? '-'} | ${r.pKB?.toFixed(1) ?? '-'} | ${r.mbps.toFixed(1)} | ${r.psnr.media?.toFixed(1) ?? '-'} / ${r.psnr.min?.toFixed(1) ?? '-'} (${r.psnr.n} dec.) | ${JSON.stringify(r.camadas)} bytes% ${JSON.stringify(r.bytesCamada)}${Object.keys(r.refIdc ?? {}).length ? ' ' + JSON.stringify(r.refIdc) : ''} | ${r.base ? `${r.base.decodificados}/${r.base.enviados} (${r.base.identicosAoFluxoCompleto} idênticos ao fluxo completo)${r.base.erro ? ' ERRO ' + r.base.erro.slice(0, 60) : ''}` : '-'} |`,
      );
  }
  await browser.close();
}

await rodar();
