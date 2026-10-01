/**
 * Álgebra de rede: malha (uma cópia por espectador) contra árvore de repasse
 * k-ária, com a escada REAL de `@tela/shared` (piso e teto de bits por pixel,
 * `presetForBitrate`). Não é benchmark: é a conta da §D de
 * `docs/engenharia/complexidade.md`, executável para ninguém a refazer à mão.
 *
 *   node e2e/bench/rede-malha-vs-arvore.calc.mjs
 *   node e2e/bench/rede-malha-vs-arvore.calc.mjs --salto=80   # ms por salto
 */
import { sobTsx, RAIZ, W, args, fmt, JSON_SAIDA } from './comum.mjs';
import { join } from 'node:path';

sobTsx(import.meta.url);

const { PRESETS, PRESET_ORDER, pisoDeBitrate, tetoDeBitrate, presetForBitrate, P2P_LIMITS, bitsPorPixel } =
  await import(join(RAIZ, 'packages/shared/src/encoding.ts'));
const { presetParaOrcamento } = await import(W('core/media/presets.ts'));

const FOLGA = P2P_LIMITS.uplinkHeadroom; // 0,75
const RESERVA_AUDIO = 141_000; // broadcast-session.ts
const SALTO_MS = Number(args['salto'] ?? 60); // jitter buffer + ½ RTT + repasse, por salto

const Ns = [5, 10, 20, 50];
const UPLINKS = [10, 50, 100, 300]; // Mbps de subida de quem transmite

/* ───────────────────────── a escada ───────────────────────── */

if (!JSON_SAIDA) {
  console.log('\nESCADA (60 fps) — nominal, piso e teto por degrau, em Mbps, e bpp do nominal');
  console.log('degrau     nominal    piso    teto    bpp nominal');
  for (const id of PRESET_ORDER) {
    const p = PRESETS[id];
    const piso = pisoDeBitrate(p.width, p.height, 60);
    const teto = tetoDeBitrate(p.width, p.height, 60);
    console.log(
      `${id.padEnd(10)} ${fmt(p.main.maxBitrate / 1e6, 1).padStart(7)}   ${fmt(piso / 1e6, 1).padStart(5)}   ${fmt(teto / 1e6, 1).padStart(5)}   ${fmt(bitsPorPixel(p.main.maxBitrate, p.width, p.height, 60), 3)}`,
    );
  }
}

const p1080 = PRESETS['p1080p60'];
const TETO_1080 = tetoDeBitrate(p1080.width, p1080.height, 60);
const PISO_1080 = pisoDeBitrate(p1080.width, p1080.height, 60);

/* ───────────────────────── malha ───────────────────────── */

/** O que a malha de hoje entrega: orçamento por espectador = (0,75·U − áudio)/N, degrau pelo piso, gasto até o teto. */
function malha(U, N) {
  const orcamentoVideo = Math.max(0, FOLGA * U * 1e6 - RESERVA_AUDIO);
  const porEspectador = orcamentoVideo / N;
  const degrau = presetParaOrcamento(porEspectador, 'fluidez');
  const p = PRESETS[degrau];
  const teto = tetoDeBitrate(p.width, p.height, 60);
  const gasto = Math.min(porEspectador, teto);
  const piso = pisoDeBitrate(p.width, p.height, 60);
  return { degrau, porEspectador, gasto, bpp: bitsPorPixel(gasto, p.width, p.height, 60), abaixoDoPiso: gasto < piso, uploadHost: gasto * N };
}

if (!JSON_SAIDA) {
  console.log(`\nMALHA — orçamento por espectador = (${FOLGA}·U − ${fmt(RESERVA_AUDIO / 1e3, 0)} kbps)/N; degrau = presetForBitrate; gasto = min(orçamento, teto do degrau)`);
  console.log('U (Mbps)   N    por espectador   degrau      gasto (Mbps)   bpp     upload do host (Mbps)');
  for (const U of UPLINKS) {
    for (const N of Ns) {
      const m = malha(U, N);
      console.log(
        `${String(U).padStart(5)}      ${String(N).padStart(2)}    ${fmt(m.porEspectador / 1e6, 2).padStart(10)} Mbps   ${m.degrau.padEnd(9)}   ${fmt(m.gasto / 1e6, 2).padStart(9)}      ${fmt(m.bpp, 3)}${m.abaixoDoPiso ? ' <piso' : '     '}   ${fmt(m.uploadHost / 1e6, 1).padStart(8)}`,
      );
    }
  }
}

/* ───────────────────────── árvore k-ária ───────────────────────── */

/** Profundidade de uma árvore k-ária completa com N nós abaixo da raiz (raiz = transmissor, profundidade 0). */
function profundidade(N, k) {
  if (k === 1) return N;
  let d = 0;
  let cabem = 0; // nós nas profundidades 1..d
  while (cabem < N) {
    d += 1;
    cabem += k ** d;
  }
  return d;
}
/** Quantos espectadores precisam repassar (nós internos entre os N). */
function internos(N, k) {
  return Math.max(0, Math.ceil((N - k) / k));
}

if (!JSON_SAIDA) {
  console.log(`\nÁRVORE k-ÁRIA — o transmissor envia k cópias; cada repassador envia até k; profundidade d = min{d : Σ_{i=1..d} k^i ≥ N}; latência extra = d·${SALTO_MS} ms`);
  console.log('N    k   d   repassadores   upload host 1080p@teto (Mbps)   upload por repassador (Mbps)   latência extra (ms)   folhas (não repassam)');
  for (const N of Ns) {
    for (const k of [2, 3, 5]) {
      const d = profundidade(N, k);
      const rep = internos(N, k);
      console.log(
        `${String(N).padStart(2)}   ${k}   ${d}   ${String(rep).padStart(12)}   ${fmt((k * TETO_1080) / 1e6, 1).padStart(29)}   ${fmt((k * TETO_1080) / 1e6 / FOLGA, 1).padStart(21)} (bruto)   ${String(d * SALTO_MS).padStart(17)}   ${String(N - rep).padStart(8)}`,
      );
    }
  }
  console.log(`\n  1080p60 no teto = ${fmt(TETO_1080 / 1e6, 1)} Mbps; no piso = ${fmt(PISO_1080 / 1e6, 1)} Mbps. "bruto" = dividido pela folga de ${FOLGA} (o que a pessoa precisa ter de subida).`);
}

/* ───────────────────────── o grau que o upload paga ───────────────────────── */

/** Com subida U (bruta), quantas cópias de 1080p60 a `b` cabem: k = ⌊(0,75·U − áudio)/b⌋. */
function grau(U, b) {
  return Math.max(0, Math.floor((FOLGA * U * 1e6 - RESERVA_AUDIO) / b));
}

if (!JSON_SAIDA) {
  console.log('\nQUE GRAU CADA SUBIDA PAGA (cópias de 1080p60 que cabem), no piso e no teto do degrau:');
  console.log('subida (Mbps)   k no piso (12,4 Mbps)   k no teto (16,2 Mbps)   k em 720p60 no piso (6,2)');
  const p720 = PRESETS['p720p60'];
  const piso720 = pisoDeBitrate(p720.width, p720.height, 60);
  for (const U of [5, 10, 20, 50, 100, 300]) {
    console.log(`${String(U).padStart(9)}        ${String(grau(U, PISO_1080)).padStart(14)}        ${String(grau(U, TETO_1080)).padStart(14)}        ${String(grau(U, piso720)).padStart(14)}`);
  }
}

/* ───────────────────────── taxa máxima com repasse (Kumar–Liu–Ross) ───────────────────────── */

/**
 * Taxa máxima que N espectadores conseguem receber todos, quando qualquer um
 * pode repassar: r* = min{ u_s, (u_s + Σ u_i)/N }  (Kumar, Liu & Ross,
 * INFOCOM 2007 — "Stochastic fluid theory for P2P streaming systems"; o mesmo
 * limite aparece em Mundinger, Weber & Weiss 2008 para disseminação de
 * arquivo). u_s = subida útil do transmissor, u_i = subida útil do espectador i.
 */
function taxaMaxima(uHost, uEspectadores) {
  const N = uEspectadores.length;
  const soma = uEspectadores.reduce((a, b) => a + b, 0);
  return Math.min(uHost, (uHost + soma) / N);
}

if (!JSON_SAIDA) {
  console.log('\nTAXA MÁXIMA POR ESPECTADOR COM REPASSE — r* = min{u_s, (u_s + Σu_i)/N}, u = 0,75·subida − áudio');
  console.log('cenário (subida do host / dos espectadores)           N=5      N=10     N=20     N=50    (Mbps por espectador; 1080p60 precisa de 12,4–16,2)');
  const cenarios = [
    ['host 100, todos 10 (ADSL/4G)', 100, () => 10],
    ['host 100, todos 50 (fibra básica)', 100, () => 50],
    ['host 50, metade 10 e metade 100', 50, (i) => (i % 2 === 0 ? 10 : 100)],
    ['host 300, todos 100', 300, () => 100],
    ['host 10, todos 100 (host fraco)', 10, () => 100],
  ];
  for (const [nome, uh, ui] of cenarios) {
    const util = (U) => Math.max(0, FOLGA * U * 1e6 - RESERVA_AUDIO);
    const linhaTxt = Ns.map((N) => fmt(taxaMaxima(util(uh), Array.from({ length: N }, (_, i) => util(ui(i)))) / 1e6, 1).padStart(6)).join('   ');
    console.log(`${nome.padEnd(50)}  ${linhaTxt}`);
  }
  console.log('\n  O limite é de FLUXO, não de árvore: uma única árvore k-ária só o atinge com múltiplas árvores/stripes (SplitStream, Castro et al. SOSP 2003) ou repasse parcial. Com uma árvore só, o que vale é o grau que o PIOR repassador paga.');
}

/* ───────────────────────── árvore com graus heterogêneos (mínima profundidade) ───────────────────────── */

/**
 * Dado o grau que cada espectador paga (k_i = cópias que a subida dele banca),
 * a árvore de profundidade mínima põe os maiores graus mais perto da raiz:
 * ordena por k_i decrescente e preenche por níveis (BFS). É ótimo por
 * argumento de troca — trocar um nó de grau maior por um de grau menor num
 * nível mais raso nunca reduz o número de vagas no nível seguinte.
 */
function arvoreMinima(kHost, graus) {
  const ordenados = [...graus].sort((a, b) => b - a);
  let nivel = [];
  let vagas = kHost;
  let d = 0;
  let i = 0;
  const niveis = [];
  while (i < ordenados.length) {
    if (vagas === 0) return { d: Infinity, niveis }; // ninguém mais pode repassar: não cabe
    d += 1;
    nivel = ordenados.slice(i, i + vagas);
    i += nivel.length;
    niveis.push(nivel.length);
    vagas = nivel.reduce((a, b) => a + b, 0);
  }
  return { d, niveis };
}

if (!JSON_SAIDA) {
  const kHost = grau(100, PISO_1080);
  console.log(`\nÁRVORE DE PROFUNDIDADE MÍNIMA com graus heterogêneos (1080p60 no piso, 12,4 Mbps por cópia), host com 100 Mbps (k=${kHost}):`);
  const mistura = (N) => Array.from({ length: N }, (_, i) => grau([10, 20, 50, 100, 300][i % 5], PISO_1080));
  for (const N of Ns) {
    const g = mistura(N);
    const r = arvoreMinima(kHost, g);
    const semRepasse = g.filter((k) => k === 0).length;
    console.log(`  N=${String(N).padStart(2)}: graus ${JSON.stringify([...new Set(g)].sort((a, b) => b - a))} (${semRepasse} sem subida para repassar) → d=${r.d}, nós por nível ${JSON.stringify(r.niveis)}, latência extra ${r.d === Infinity ? '—' : r.d * SALTO_MS + ' ms'}`);
  }
  console.log('\n  Quem tem 10 Mbps de subida não repassa nem UMA cópia de 1080p no piso (0,75·10 − 0,14 = 7,4 < 12,4): é folha. A árvore depende dos de 50+.');
}
