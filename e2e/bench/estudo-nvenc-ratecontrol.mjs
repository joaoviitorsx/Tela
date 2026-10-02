/**
 * Estudo do codec (docs/engenharia/estudo/1-codec.md, §5): controle de taxa e
 * presets do NVENC, medidos de verdade (ffmpeg `h264_nvenc`, mesma GPU do
 * `tela-captura.c`). Para cada variante: Mbps efetivo, PSNR-Y contra a fonte,
 * maior quadro (exceto o primeiro), vazão de encode (quadros/s, ffmpeg).
 *
 * Fontes sintéticas, 1920x1080@60:
 *   mandelbrot : detalhe fino em movimento contínuo (pior caso de bitrate)
 *   testsrc2   : bordas nítidas, texto e rolagem (parecida com UI/jogo 2D)
 *   estatica   : quadro parado + um remendo de 100x100 em movimento (tela de
 *                trabalho/menu: o caso do "conteúdo estático")
 *
 *   node e2e/bench/estudo-nvenc-ratecontrol.mjs --grupo=presets|rc|vbv|aq|perfil|av1|estatica [--seg=4] [--mbps=12]
 *
 * Linha de base = o que o `tela-captura.c` usa hoje: p4, tune ull, CBR,
 * VBV de 4 quadros, spatial-aq, bframes 0, zerolatency, baseline.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a); return [m[1], m[2] === '' ? true : m[2]]; }));
const SEG = Number(args['seg'] ?? 4);
const MBPS = Number(args['mbps'] ?? 12);
const GRUPO = String(args['grupo'] ?? 'rc');
const dir = mkdtempSync(join(tmpdir(), 'rc-'));
const CACHE = join(tmpdir(), 'tela-estudo-fontes');
mkdirSync(CACHE, { recursive: true });

/** Renderiza a fonte uma vez em ffv1 (sem perdas): o lavfi `mandelbrot` roda a ~17 q/s e mascararia a vazão do encoder. */
function fonteEmArquivo(fonte) {
  const arq = join(CACHE, `${fonte}-${SEG}s.mkv`);
  if (!existsSync(arq)) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', FONTES[fonte], '-t', String(SEG), '-c:v', 'ffv1', '-level', '3', '-g', '1', arq], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  return arq;
}

const FONTES = {
  mandelbrot: 'mandelbrot=s=1920x1080:r=60:end_scale=0.01,format=yuv420p',
  testsrc2: 'testsrc2=s=1920x1080:r=60,format=yuv420p',
  estatica: "testsrc2=s=1920x1080:r=60,split[a][b];[a]trim=end_frame=1,loop=loop=-1:size=1,setpts=N/60/TB[bg];[b]crop=100:100:0:0[cur];[bg][cur]overlay=x='mod(n*9,1800)':y=500,format=yuv420p",
};

function enc({ fonte, nome, mbps = MBPS, vbvQuadros = 4, rc = 'cbr', preset = 'p4', tune = 'ull', multipass = null, saq = true, taq = false, profile = 'baseline', codec = 'h264', extra = [] }) {
  const arq = join(dir, `${fonte}-${nome.replace(/\W+/g, '_')}.${codec === 'av1' ? 'ivf' : 'h264'}`);
  const vbv = Math.round((mbps * 1000 / 60) * vbvQuadros);
  const comum = ['-hide_banner', '-loglevel', 'error', '-stats', '-y', '-i', fonteEmArquivo(fonte)];
  const a = codec === 'av1'
    ? [...comum, '-c:v', 'av1_nvenc', '-preset', preset, '-tune', tune, '-rc', rc, '-b:v', `${mbps}M`, '-maxrate', `${mbps}M`, '-bufsize', `${vbv}k`, '-spatial-aq', saq ? '1' : '0', '-g', '100000']
    : [...comum, '-c:v', 'h264_nvenc', '-profile:v', profile, '-preset', preset, '-tune', tune, '-rc', rc, '-b:v', `${mbps}M`, '-maxrate', `${rc === 'vbr' ? Math.round(mbps * 1.5) : mbps}M`, '-bufsize', `${vbv}k`,
      '-bf', '0', '-zerolatency', '1', '-spatial-aq', saq ? '1' : '0', '-temporal-aq', taq ? '1' : '0', '-g', '100000', '-forced-idr', '1'];
  if (multipass !== null) a.push('-multipass', String(multipass));
  a.push(...extra, '-f', codec === 'av1' ? 'ivf' : 'h264', arq);
  const t0 = Date.now();
  const r = spawnSync('ffmpeg', a, { encoding: 'utf8' });
  const seg = (Date.now() - t0) / 1000;
  if (r.status !== 0) return { nome, erro: r.stderr.slice(0, 160) };
  const p = spawnSync('ffmpeg', ['-hide_banner', '-f', codec === 'av1' ? 'ivf' : 'h264', '-i', arq, '-i', fonteEmArquivo(fonte), '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /PSNR y:([\d.]+)/.exec(p.stderr);
  const pk = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=size', '-of', 'csv=p=0', '-f', codec === 'av1' ? 'ivf' : 'h264', arq], { encoding: 'utf8' });
  const tam = pk.stdout.trim().split('\n').map(Number);
  const total = tam.reduce((s, x) => s + x, 0);
  return { nome, mbps: (total * 8) / SEG / 1e6, psnr: m ? Number(m[1]) : null, pico: Math.max(...tam.slice(1)) / 1024, minimo: Math.min(...tam.slice(1)), fps: tam.length / seg, quadros: tam.length };
}

function linha(f, r) {
  if (r.erro) return `| ${f} | ${r.nome} | erro: ${r.erro.replace(/\n/g, ' ')} |`;
  return `| ${f} | ${r.nome} | ${r.mbps.toFixed(2)} | ${r.psnr?.toFixed(2) ?? '-'} | ${r.pico.toFixed(1)} | ${r.minimo} | ${r.fps.toFixed(0)} |`;
}

const base = {};
const GRUPOS = {
  presets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((p) => ({ nome: `${p} ull`, preset: p })),
  rc: [
    { nome: 'CBR (base)', ...base },
    { nome: 'VBR maxrate 1,5x', rc: 'vbr' },
    { nome: 'tune ll (low latency)', tune: 'll' },
    { nome: 'multipass quarter', multipass: 1 },
    { nome: 'multipass full', multipass: 2 },
    { nome: 'p4 ll + multipass quarter', tune: 'll', multipass: 1 },
  ],
  vbv: [1, 2, 4, 8, 30].map((v) => ({ nome: `CBR VBV ${v} quadro(s)`, vbvQuadros: v })),
  aq: [
    { nome: 'sem AQ', saq: false },
    { nome: 'spatial-aq (base)', saq: true },
    { nome: 'spatial+temporal-aq', saq: true, taq: true },
    { nome: 'temporal-aq só', saq: false, taq: true },
  ],
  perfil: [8, 10, 12, 16].flatMap((m) => ['baseline', 'main', 'high'].map((pf) => ({ nome: `${pf} ${m} Mbps`, profile: pf, mbps: m }))),
  av1: [4, 6, 8, 12, 16].flatMap((m) => [{ nome: `AV1 NVENC ${m} Mbps`, codec: 'av1', mbps: m }, { nome: `H.264 high ${m} Mbps`, profile: 'high', mbps: m }]),
  estatica: [
    { nome: 'CBR (base)' },
    { nome: 'VBR maxrate 1,5x', rc: 'vbr' },
    { nome: 'CBR + temporal-aq', taq: true },
  ],
};

console.log(`\nNVENC (h264_nvenc), 1080p60, ${SEG} s, alvo ${MBPS} Mbps, grupo ${GRUPO}\n`);
console.log('| fonte | variante | Mbps efetivo | PSNR-Y dB | maior quadro KB (exceto 1º) | menor quadro B | quadros/s de encode |');
console.log('|---|---|---|---|---|---|---|');
const fontes = GRUPO === 'estatica' ? ['estatica'] : ['mandelbrot', 'testsrc2'];
for (const f of fontes) for (const v of GRUPOS[GRUPO] ?? []) console.log(linha(f, enc({ fonte: f, ...v })));
