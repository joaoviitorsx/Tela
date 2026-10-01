/**
 * `FilaDeInjecao` (array + `push/shift` + `find`) contra um anel indexado por
 * `seq` — o mesmo contrato, O(1) por vaga.
 *
 * O que se mede: 10 s simulados a 60 fps, N senders pedindo vaga a cada quadro
 * (o caminho quente do "um encode, N envios"), mais `atraso()` a 10 Hz como no
 * worker. Dois cenários:
 *
 *   em-dia     todos os senders consomem toda vaga — o caso normal, e o PIOR
 *              para o `find`: o quadro que o sender quer é o mais NOVO, e o
 *              array guarda do mais velho para o mais novo, então a busca
 *              linear percorre ~Q entradas em TODA vaga;
 *   atrasados  um terço dos senders só consome vaga a cada 2 ou 3 quadros,
 *              cai para trás, estoura a janela e pede IDR — exercita os ramos
 *              de `primeiro`/`esperandoChave`.
 *
 * Antes de medir, os dois são executados sobre o MESMO cenário e cada decisão
 * é comparada: um anel mais rápido que devolve outro quadro não vale nada.
 *
 *   node e2e/bench/fila-de-injecao.bench.mjs
 */
import { sobTsx, W, cabecalho, medir, fmt, linha, rng, JSON_SAIDA } from './comum.mjs';

sobTsx(import.meta.url);

const { FilaDeInjecao, QUADROS_GUARDADOS, SENDER_MORTO_MS } = await import(W('core/media/fila-de-injecao.ts'));

/* ─────────────────────────── a alternativa: anel por seq ─────────────────────────── */

/**
 * Mesmo contrato de `FilaDeInjecao`, guardando os últimos Q quadros num anel
 * indexado por `seq % Q`. Invariante: os seqs chegam em ordem e sem buraco (o
 * codificador numera), então "o quadro de seq s" está em `anel[s % Q]` se e só
 * se `ultimoSeq - Q < s <= ultimoSeq`.
 */
class FilaAnel {
  constructor(agora, capacidade = QUADROS_GUARDADOS) {
    this.agora = agora;
    this.Q = capacidade;
    this.anel = new Array(capacidade).fill(undefined);
    this.ultimoSeq = -1;
    this.senders = new Map();
  }
  chegou(quadro) {
    this.anel[quadro.seq % this.Q] = quadro;
    this.ultimoSeq = quadro.seq;
  }
  entrou(sender) {
    this.senders.set(sender, { proximo: -1, esperandoChave: true, ultimaVaga: this.agora() });
  }
  saiu(sender) {
    this.senders.delete(sender);
  }
  pediuChave(sender) {
    const s = this.senders.get(sender);
    if (s !== undefined) s.esperandoChave = true;
  }
  /** O seq mais antigo ainda guardado, ou -1 se vazio. */
  primeiroSeq() {
    return this.ultimoSeq < 0 ? -1 : Math.max(0, this.ultimoSeq - this.Q + 1);
  }
  vaga(sender) {
    let s = this.senders.get(sender);
    if (s === undefined) {
      this.entrou(sender);
      s = this.senders.get(sender);
    }
    s.ultimaVaga = this.agora();
    if (s.esperandoChave) {
      const ponta = this.ultimoSeq < 0 ? undefined : this.anel[this.ultimoSeq % this.Q];
      if (ponta !== undefined && ponta.chave && ponta.seq >= s.proximo) {
        s.esperandoChave = false;
        s.proximo = ponta.seq + 1;
        return { tipo: 'enviar', quadro: ponta };
      }
      return { tipo: 'descartar', pedirChave: true };
    }
    const p = s.proximo;
    if (p >= this.primeiroSeq() && p <= this.ultimoSeq) {
      const quadro = this.anel[p % this.Q];
      s.proximo += 1;
      return { tipo: 'enviar', quadro };
    }
    if (this.ultimoSeq >= 0 && p < this.primeiroSeq()) {
      s.esperandoChave = true;
      return { tipo: 'descartar', pedirChave: true };
    }
    return { tipo: 'descartar', pedirChave: false };
  }
  atraso() {
    const agora = this.agora();
    let pior = 0;
    for (const s of this.senders.values()) {
      if (agora - s.ultimaVaga > SENDER_MORTO_MS) continue;
      if (s.esperandoChave || s.proximo < 0) continue;
      pior = Math.max(pior, this.ultimoSeq + 1 - s.proximo);
    }
    return pior;
  }
}

/* ─────────────────────────── cenário ─────────────────────────── */

const FPS = 60;
const SEGUNDOS = 10;
const QUADROS = FPS * SEGUNDOS;
const GOP = 120; // IDR a cada 2 s, mais os pedidos

/** Gera o roteiro uma vez; os dois candidatos o executam igual. */
function roteiro(n, modo, semente = 7) {
  const r = rng(semente);
  const senders = Array.from({ length: n }, (_, i) => `s${i}`);
  // Entrada escalonada ao longo do primeiro segundo.
  const entrada = senders.map((_, i) => Math.floor((i / n) * FPS));
  const passo = senders.map((_, i) => (modo === 'atrasados' && i % 3 === 0 ? 2 + (i % 2) : 1));
  const chaveExtra = new Set();
  for (let q = 0; q < QUADROS; q += 1) if (r() < 0.02) chaveExtra.add(q);
  return { senders, entrada, passo, chaveExtra };
}

function executar(fila, cen, agoraRef, coletar = null) {
  let pediuChave = false;
  let enviados = 0;
  for (let q = 0; q < QUADROS; q += 1) {
    agoraRef.t = (q * 1000) / FPS;
    const chave = q % GOP === 0 || pediuChave || cen.chaveExtra.has(q);
    pediuChave = false;
    fila.chegou({ seq: q, chave, dados: q });
    for (let i = 0; i < cen.senders.length; i += 1) {
      if (q === cen.entrada[i]) fila.entrou(cen.senders[i]);
      if (q < cen.entrada[i] || q % cen.passo[i] !== 0) continue;
      const d = fila.vaga(cen.senders[i]);
      if (coletar !== null) coletar.push(d.tipo === 'enviar' ? d.quadro.seq : d.pedirChave ? -2 : -1);
      if (d.tipo === 'enviar') enviados += 1;
      else if (d.pedirChave) pediuChave = true;
    }
    if (q % 6 === 0) {
      const a = fila.atraso();
      if (coletar !== null) coletar.push(1_000_000 + a);
      enviados += a * 0; // mantém o valor vivo
    }
  }
  return enviados;
}

function candidatos() {
  const agoraRef = { t: 0 };
  return {
    agoraRef,
    atual: () => new FilaDeInjecao(() => agoraRef.t),
    anel: () => new FilaAnel(() => agoraRef.t),
  };
}

/* ─────────────────────────── equivalência ─────────────────────────── */

for (const modo of ['em-dia', 'atrasados']) {
  for (const n of [1, 5, 20, 50]) {
    const cen = roteiro(n, modo);
    const { agoraRef, atual, anel } = candidatos();
    const a = [];
    const b = [];
    executar(atual(), cen, agoraRef, a);
    executar(anel(), cen, agoraRef, b);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      const i = a.findIndex((v, j) => v !== b[j]);
      console.error(`DIVERGÊNCIA ${modo} N=${n} na decisão ${i}: atual=${a[i]} anel=${b[i]}`);
      process.exit(1);
    }
  }
}
if (!JSON_SAIDA) console.log('equivalência: as decisões do anel são idênticas às da fila atual em todos os cenários.');

/* ─────────────────────────── medição ─────────────────────────── */

cabecalho(`FilaDeInjecao — ${SEGUNDOS} s simulados a ${FPS} fps, Q=${QUADROS_GUARDADOS}`);

if (!JSON_SAIDA) {
  console.log('modo       N   vagas    atual (ms)   anel (ms)   ns/vaga atual   ns/vaga anel   ganho');
}
for (const modo of ['em-dia', 'atrasados']) {
  for (const n of [5, 20, 50]) {
    const cen = roteiro(n, modo);
    const { agoraRef, atual, anel } = candidatos();
    const vagas = cen.senders.reduce(
      (soma, _, i) => soma + Math.ceil((QUADROS - cen.entrada[i]) / cen.passo[i]),
      0,
    );
    const ma = medir(() => executar(atual(), cen, agoraRef));
    const mb = medir(() => executar(anel(), cen, agoraRef));
    const nsA = (ma.medianaMs * 1e6) / vagas;
    const nsB = (mb.medianaMs * 1e6) / vagas;
    if (!JSON_SAIDA) {
      console.log(
        `${modo.padEnd(10)} ${String(n).padStart(2)}  ${String(vagas).padStart(6)}   ` +
          `${fmt(ma.medianaMs).padStart(9)}    ${fmt(mb.medianaMs).padStart(8)}   ` +
          `${fmt(nsA, 0).padStart(13)}   ${fmt(nsB, 0).padStart(12)}   ${fmt(ma.medianaMs / mb.medianaMs, 1)}×`,
      );
    }
    linha({ bench: 'fila-de-injecao', modo, n, vagas, atualMs: ma.medianaMs, anelMs: mb.medianaMs, nsPorVagaAtual: nsA, nsPorVagaAnel: nsB });
  }
}

/* ─────────────────────────── só o chegou(): push+shift vs anel ─────────────────────────── */

if (!JSON_SAIDA) console.log('\nsó chegou() × 100 000 quadros (push+shift a Q=180 vs escrita no anel):');
{
  const ag = { t: 0 };
  const fa = new FilaDeInjecao(() => ag.t);
  const fb = new FilaAnel(() => ag.t);
  const ma = medir(() => {
    for (let q = 0; q < 100_000; q += 1) fa.chegou({ seq: q, chave: false, dados: q });
    return fa;
  });
  const mb = medir(() => {
    for (let q = 0; q < 100_000; q += 1) fb.chegou({ seq: q, chave: false, dados: q });
    return fb;
  });
  if (!JSON_SAIDA) {
    console.log(`  push+shift: ${fmt(ma.medianaMs)} ms (${fmt((ma.medianaMs * 1e6) / 1e5, 0)} ns/quadro)`);
    console.log(`  anel:       ${fmt(mb.medianaMs)} ms (${fmt((mb.medianaMs * 1e6) / 1e5, 0)} ns/quadro)`);
  }
  linha({ bench: 'fila-de-injecao/chegou', pushShiftMs: ma.medianaMs, anelMs: mb.medianaMs });
}
