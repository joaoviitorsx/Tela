/**
 * D0c — o `tela-captura` (nativo/linux) sozinho, sem Electron.
 *
 * Sobe o processo na fonte `mutter:<conector>` (sem diálogo), lê o protocolo,
 * mede CPU pelo /proc e confere o comportamento que o "um encode" exige:
 *
 *   - quadro-chave só quando pedido (o primeiro, a ordem `chave`, a troca de
 *     tamanho) — troca de BITRATE não pode gerar IDR;
 *   - o tamanho muda quando a ordem `alvo` manda;
 *   - o H.264 decodifica (ffprobe no arquivo gravado).
 *
 *   pnpm --filter @tela/desktop d0:nativo        (depois de nativo/linux/build.sh)
 *   CONECTOR=HDMI-1 SEGUNDOS=20 ...
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LeitorDoProtocolo } from './protocolo-captura.mjs';

const BIN = fileURLToPath(new URL('../nativo/linux/build/tela-captura', import.meta.url));
const CONECTOR = process.env.CONECTOR ?? 'eDP-1';
const SEGUNDOS = Number(process.env.SEGUNDOS ?? 18);
const SAIDA = process.env.SAIDA ?? '/tmp/tela-captura.h264';

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const cpuDe = (pid) => {
  const c = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return (Number(c[11]) + Number(c[12])) / 100;
};

const filho = spawn(BIN, [`--fonte=mutter:${CONECTOR}`, '--alvo=1920,1080,60,12000000'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const quadros = [];
const stats = [];
let pronto = null;
const erros = [];
const pedacos = [];
const leitor = new LeitorDoProtocolo({
  quadro: (q) => {
    quadros.push({ t: performance.now(), chave: q.chave, w: q.width, h: q.height, bytes: q.dados.byteLength, seq: q.seq });
    pedacos.push(Buffer.from(q.dados));
  },
  evento: (e) => {
    if (e.evento === 'pronto') pronto = e;
    else if (e.evento === 'stats') stats.push(e);
    else if (e.evento === 'erro') erros.push(e);
  },
});
filho.stdout.on('data', (b) => leitor.receber(b));
const ordem = (linha) => filho.stdin.write(`${linha}\n`);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const fim = new Promise((r) => filho.on('exit', (code) => r(code)));

await esperar(3000);
console.log(`\npronto: ${JSON.stringify(pronto)}  erros: ${JSON.stringify(erros)}`);
const marcas = {};
if (filho.exitCode !== null) { console.log(`saiu cedo: ${filho.exitCode}`); process.exit(1); }
const cpu0 = cpuDe(filho.pid);
const t0 = performance.now();
const q0 = quadros.length;

// Linha do tempo das ordens, para conferir quem gerou cada quadro-chave.
marcas.bitrate = performance.now() + 4000;
setTimeout(() => ordem('alvo 1920 1080 60 6000000'), 4000);
marcas.chave = performance.now() + 7000;
setTimeout(() => ordem('chave'), 7000);
marcas.tamanho = performance.now() + 10000;
setTimeout(() => ordem('alvo 1280 720 60 6000000'), 10000);
// A segunda troca é a que travava: o pipeline reciclado não voltava a capturar.
marcas.tamanho2 = performance.now() + 13000;
setTimeout(() => ordem('alvo 1024 576 60 6000000'), 13000);
await esperar(SEGUNDOS * 1000);
const dt = (performance.now() - t0) / 1000;
const cpu = (cpuDe(filho.pid) - cpu0) / dt;
ordem('parar');
const codigo = await Promise.race([fim, esperar(5000).then(() => 'timeout')]);

const medidos = quadros.slice(q0);
const fps = medidos.length / dt;
const chaves = medidos.filter((q) => q.chave);
const perto = (t, alvo) => t >= alvo && t < alvo + 1000;
console.log(`\n${medidos.length} quadros em ${dt.toFixed(1)}s = ${fps.toFixed(1)} q/s · CPU ${cpu.toFixed(3)} núcleo`);
console.log(`chaves em t+ ${chaves.map((q) => ((q.t - t0) / 1000).toFixed(2)).join(', ')}`);
console.log(`stats (meio): ${JSON.stringify(stats.slice(5, 7))}`);

ok(pronto !== null, `fonte negociada (${pronto?.fonte?.width}x${pronto?.fonte?.height}, memória ${pronto?.memoria})`);
ok(erros.length === 0, `sem erro (${erros.map((e) => e.codigo).join(', ') || 'nenhum'})`);
ok(quadros[0]?.chave === true, 'o primeiro quadro é IDR');
ok(!chaves.some((q) => perto(q.t, marcas.bitrate)), 'troca de bitrate não gera IDR');
ok(chaves.some((q) => perto(q.t, marcas.chave)), 'a ordem `chave` gera IDR em menos de 1 s');
ok(chaves.some((q) => perto(q.t, marcas.tamanho) && q.w === 1280 && q.h === 720), 'a troca de tamanho sai em 1280x720, começando por IDR');
ok(chaves.some((q) => perto(q.t, marcas.tamanho2) && q.w === 1024 && q.h === 576), 'a segunda troca de tamanho também sai, em 1024x576');
const fpsEntre = (de, ate) => medidos.filter((q) => q.t >= de && q.t < ate).length / ((ate - de) / 1000);
const fpsAntes = fpsEntre(t0 + 1000, marcas.tamanho);
const fpsDepois = fpsEntre(marcas.tamanho2 + 1000, t0 + SEGUNDOS * 1000);
ok(fpsDepois >= fpsAntes * 0.7, `a captura segue depois das trocas (${fpsAntes.toFixed(0)} → ${fpsDepois.toFixed(0)} q/s)`);
ok(chaves.length <= 4, `nenhum IDR além dos pedidos (${chaves.length})`);
ok(cpu <= 0.5, `CPU ≤ 0,5 núcleo (${cpu.toFixed(3)})`);
ok(codigo === 0, `encerra limpo com \`parar\` (${codigo})`);

const bitrate = (de, ate) => {
  const qs = medidos.filter((q) => q.t >= de && q.t < ate);
  return (qs.reduce((s, q) => s + q.bytes, 0) * 8) / ((ate - de) / 1000) / 1e6;
};
console.log(`bitrate medido: ${bitrate(t0 + 1000, marcas.bitrate).toFixed(1)} Mbps antes, ${bitrate(marcas.bitrate + 1000, marcas.tamanho).toFixed(1)} Mbps depois de pedir 6`);

writeFileSync(SAIDA, Buffer.concat(pedacos));
try {
  const r = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,profile,width,height,nb_read_frames', '-of', 'json', SAIDA], { encoding: 'utf8' });
  const s = JSON.parse(r).streams[0];
  console.log(`ffprobe: ${JSON.stringify(s)}`);
  ok(Number(s.nb_read_frames) >= quadros.length * 0.95, `o H.264 decodifica (${s.nb_read_frames} de ${quadros.length} quadros)`);
} catch (e) {
  ok(false, `ffprobe: ${e.message.split('\n')[0]}`);
}
console.log(process.exitCode ? '\n=== D0c FALHOU ===' : '\n=== D0c PASSOU ===');
