/**
 * D3 — "só o jogo" no Linux, contra o PipeWire de verdade. Opt-in: mexe no
 * grafo de áudio da sessão (por pouco tempo, e só com nós próprios).
 *
 *   pnpm --filter @tela/desktop build && node apps/desktop/d0/audio-jogo.mjs
 *
 * O que faz, nesta ordem:
 *
 *   1. cria uma "saída" de mentira SILENCIOSA (`tela_teste_saida`, um null sink):
 *      nada sai nos alto-falantes e nenhum dispositivo seu é tocado;
 *   2. dois reprodutores descartáveis tocam nela: o "jogo" (440 Hz) e a "call"
 *      (880 Hz) — a mesma situação de quem joga com o Discord aberto;
 *   3. `SomDoJogoLinux` (o MESMO código do app) lista os apps, escolhe o jogo,
 *      cria o sink Tela-Jogo + a fonte virtual Tela-Jogo-Entrada (o que o
 *      Chromium enxerga: ele não lista monitores de sink) e move só o stream
 *      do jogo;
 *   4. grava 2 s da FONTE Tela-Jogo-Entrada e confere por Goertzel: há 440 Hz
 *      e NÃO há 880 Hz — só o jogo chegou;
 *   5. `parar()` e confere: o jogo voltou para a saída de antes, o sink, a
 *      fonte e os metadados sumiram;
 *   6. modo "Sistema": cria a fonte do monitor da saída padrão, confere que
 *      existe e está ligada (sem tocar som nenhum) e remove;
 *   7. limpa o que criou e confere que o grafo ficou como começou.
 *
 * Código de saída 0 só se tudo passou.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { efeitosLinux } from '../dist/main/som/efeitos-linux.js';
import { lerGrafo } from '../dist/main/som/grafo-pw.js';
import { SomDoJogoLinux } from '../dist/main/som/som-jogo-linux.js';

const TAXA = 48_000;
const SAIDA_FALSA = 'tela_teste_saida';
let falhou = false;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) falhou = true;
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function grafo() {
  return lerGrafo(JSON.parse(sh('pw-dump', [])));
}
/** Nós criados pelo app (a saída silenciosa do teste, `tela_teste_*`, não conta). */
const ehNosso = (n) => n.nome.startsWith('tela_jogo') || n.nome.startsWith('tela_sistema');
const nomesDosNos = () => new Set(grafo().nos.map((n) => n.nome));

/** WAV estéreo 16 bit com uma senoide, para o `pw-play`. */
function escreverTom(arquivo, hz, segundos, amplitude) {
  const n = TAXA * segundos;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(TAXA, 24);
  buf.writeUInt32LE(TAXA * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / TAXA) * amplitude * 32767);
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 46 + i * 4);
  }
  writeFileSync(arquivo, buf);
}

/** Lê as amostras (canal esquerdo) de um WAV s16 do `pw-record`. */
function amostras(arquivo) {
  const b = readFileSync(arquivo);
  let p = 12;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const tam = b.readUInt32LE(p + 4);
    if (id === 'data') {
      const canais = b.readUInt16LE(22);
      const fim = Math.min(b.length, p + 8 + tam);
      const out = [];
      for (let i = p + 8; i + 2 * canais <= fim; i += 2 * canais) out.push(b.readInt16LE(i) / 32768);
      return out;
    }
    p += 8 + tam + (tam % 2);
  }
  return [];
}

/** Energia na frequência `hz` (Goertzel), normalizada pela amplitude. */
function goertzel(x, hz) {
  const w = (2 * Math.PI * hz) / TAXA;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s0 = v + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / x.length;
}
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));

async function gravar(alvo, arquivo, ms, doMonitor = true) {
  const p = spawn('pw-record', ['--target', alvo, ...(doMonitor ? ['-P', 'stream.capture.sink=true'] : []), '--rate', String(TAXA), '--channels', '2', '--format', 's16', arquivo], {
    stdio: 'ignore',
  });
  await dormir(ms);
  p.kill('SIGINT');
  await new Promise((r) => p.on('exit', r));
}

const dir = mkdtempSync(join(tmpdir(), 'tela-audio-jogo-'));
const filhos = [];
let idDaSaidaFalsa = null;
const antes = nomesDosNos();

try {
  // 1. Precondições: sem PipeWire não há o que testar (e não é falha do código).
  for (const f of ['pw-dump', 'pw-cli', 'pw-play', 'pw-record', 'pw-loopback', 'pw-metadata']) {
    try {
      sh(f, ['--version']);
    } catch {
      console.log(`pulado: ${f} não está instalado (pacote pipewire-utils).`);
      process.exit(0);
    }
  }
  ok(!antes.has('tela_jogo'), 'ponto de partida: não há sink Tela-Jogo no grafo');

  // 2. A saída silenciosa e os dois reprodutores.
  sh('pw-cli', [
    'create-node',
    'adapter',
    `{ factory.name=support.null-audio-sink node.name=${SAIDA_FALSA} media.class=Audio/Sink object.linger=true audio.position=[FL FR] node.description=Teste-Saida }`,
  ]);
  await dormir(300);
  const saida = grafo().nos.find((n) => n.nome === SAIDA_FALSA);
  ok(saida !== undefined, 'saída silenciosa criada');
  idDaSaidaFalsa = saida?.id ?? null;

  const jogo = join(dir, 'jogo.wav');
  const call = join(dir, 'call.wav');
  escreverTom(jogo, 440, 30, 0.4);
  escreverTom(call, 880, 30, 0.4);
  for (const [arq, nome] of [
    [jogo, 'Tela-Teste-Jogo'],
    [call, 'Tela-Teste-Call'],
  ]) {
    filhos.push(spawn('pw-play', ['--target', SAIDA_FALSA, '-P', `application.name=${nome}`, arq], { stdio: 'ignore' }));
  }
  await dormir(1200);

  // 3. O código do app.
  const som = new SomDoJogoLinux(efeitosLinux(() => new Set([process.pid])));
  const apps = (await som.listar()) ?? [];
  const appJogo = apps.find((a) => a.nome === 'Tela-Teste-Jogo');
  const appCall = apps.find((a) => a.nome === 'Tela-Teste-Call');
  ok(appJogo !== undefined && appCall !== undefined, `lista os dois apps (${apps.map((a) => a.nome).join(', ')})`);
  if (appJogo === undefined) throw new Error('app de teste não listado');

  const r = await som.iniciar(appJogo.id, { encerrou: (f) => ok(false, `encerrou sozinho: ${f.motivo}`) });
  ok(r.ok, `iniciar → ${JSON.stringify(r)}`);
  if (!r.ok) throw new Error('não iniciou');
  await dormir(700);

  const g = grafo();
  const destino = (nome) => {
    const no = g.nos.find((n) => n.app === nome);
    const l = g.links.find((x) => x.saida === no?.id);
    return g.nos.find((n) => n.id === l?.entrada)?.nome;
  };
  ok(destino('Tela-Teste-Jogo') === 'tela_jogo', `o jogo agora toca no sink do Tela (${destino('Tela-Teste-Jogo')})`);
  ok(destino('Tela-Teste-Call') === SAIDA_FALSA, `a call ficou onde estava (${destino('Tela-Teste-Call')})`);
  const retorno = g.nos.find((n) => n.nome === 'tela_jogo_retorno');
  const lr = g.links.find((x) => x.saida === retorno?.id);
  ok(g.nos.find((n) => n.id === lr?.entrada)?.nome === SAIDA_FALSA, 'o jogador segue ouvindo: o retorno chega na saída de antes');

  ok(g.nos.some((n) => n.nome === 'tela_jogo_mic' && n.classe === 'Audio/Source'), 'a fonte virtual Tela-Jogo-Entrada existe (é o que o Chromium lista)');

  // 4. O que os amigos ouviriam: o que a página captura, a fonte virtual.
  const gravado = join(dir, 'fonte.wav');
  await gravar('tela_jogo_mic', gravado, 2200, false);
  const x = amostras(gravado).slice(TAXA / 5); // descarta o 1º quinto de segundo (arranque)
  const e440 = goertzel(x, 440);
  const e880 = goertzel(x, 880);
  console.log(`  .. ${x.length} amostras · rms ${rms(x).toFixed(3)} · 440 Hz ${e440.toFixed(4)} · 880 Hz ${e880.toFixed(4)}`);
  ok(x.length > TAXA, 'gravou ~2 s da fonte');
  ok(rms(x) > 0.02 && e440 > 0.05, 'há energia: o som do jogo chega na fonte');
  ok(e880 < e440 / 20, 'a call (880 Hz) NÃO está na fonte: só o jogo');

  // 5. Parar devolve tudo.
  await som.parar();
  await dormir(500);
  const g2 = grafo();
  ok(!g2.nos.some(ehNosso), 'o sink, o retorno e a fonte sumiram');
  ok(!g2.metadados.some((m) => m.chave === 'target.object' && m.valor === 'tela_jogo'), 'nenhum metadado aponta para o sink');
  const noJogo = g2.nos.find((n) => n.app === 'Tela-Teste-Jogo');
  const l2 = g2.links.find((l) => l.saida === noJogo?.id);
  ok(g2.nos.find((n) => n.id === l2?.entrada)?.nome === SAIDA_FALSA, 'o jogo voltou para a saída de antes');

  // 6. Modo "Sistema": só a existência e a limpeza da fonte — não há como
  // afirmar o que toca na saída REAL sem tocar som nela.
  const sis = await som.iniciarSistema({ encerrou: (f) => ok(false, `sistema encerrou sozinho: ${f.motivo}`) });
  ok(sis.ok && sis.value.descricao === 'Tela-Sistema-Entrada', `sistema → ${JSON.stringify(sis)}`);
  await dormir(500);
  const g3 = grafo();
  const fonte = g3.nos.find((n) => n.nome === 'tela_sistema_mic');
  ok(fonte?.classe === 'Audio/Source', 'a fonte do sistema existe');
  const cap = g3.nos.find((n) => n.nome === 'tela_sistema_cap');
  const ls = g3.links.find((l) => l.entrada === cap?.id);
  const padrao = g3.metadados.find((m) => m.chave === 'default.audio.sink');
  const nomePadrao = typeof padrao?.valor === 'object' && padrao.valor !== null ? padrao.valor.name : null;
  ok(g3.nos.find((n) => n.id === ls?.saida)?.nome === nomePadrao, `a fonte do sistema lê o monitor da saída padrão (${nomePadrao})`);
  await som.parar();
  await dormir(500);
  ok(!grafo().nos.some(ehNosso), 'a fonte do sistema sumiu');
} catch (erro) {
  console.error(erro);
  falhou = true;
} finally {
  // 6. Limpeza do que ESTE teste criou — e só disso.
  for (const f of filhos) f.kill('SIGTERM');
  await dormir(300);
  if (idDaSaidaFalsa !== null) {
    try {
      sh('pw-cli', ['destroy', String(idDaSaidaFalsa)]);
    } catch {
      // já tinha sumido
    }
  }
  await dormir(500);
  rmSync(dir, { recursive: true, force: true });
  const depois = nomesDosNos();
  const sobrou = [...depois].filter((n) => !antes.has(n));
  ok(sobrou.length === 0, `nada sobrou no grafo${sobrou.length > 0 ? `: ${sobrou.join(', ')}` : ''}`);
}

console.log(falhou ? '\nFALHOU' : '\nPASSOU');
process.exit(falhou ? 1 : 0);
