/**
 * O custo das CÓPIAS do quadro codificado no caminho do "um encode, N envios".
 *
 * Por quadro, hoje:
 *   1. `chunk.copyTo(dados)` no codificador (WebCodecs) — 1 cópia de B bytes;
 *   2. `postMessage(chunk, [dados])` — transferência, zero cópia;
 *   3. `quadro.data = real.dados.slice(0)` POR SENDER no worker — N cópias de B;
 *   4. no desktop, `port1.postMessage({... dados})` SEM lista de transferência
 *      (apps/desktop/d0/injecao.mjs) — mais 1 clone estruturado de B.
 *
 * Isto mede 3 e 4 em Node: `ArrayBuffer.slice(0)` de B bytes N vezes por quadro
 * a 60 fps, e `structuredClone` de um ArrayBuffer com e sem transferência.
 * Não é o Chromium, mas memcpy é memcpy: o que interessa é a ordem de grandeza
 * de bytes/s e de ms/s, e se cabe ao lado do jogo.
 *
 * O que NÃO dá para medir aqui, e fica para o navegador: o custo interno do
 * Encoded Transform ao atribuir `quadro.data` (o Chromium copia o ArrayBuffer
 * para um `rtc::Buffer` ao escrever o quadro de volta — provavelmente mais UMA
 * cópia por sender), e a pressão de GC de N ArrayBuffers de 25 KB por quadro.
 *
 *   node e2e/bench/copias-por-sender.bench.mjs
 */
import { cabecalho, medir, fmt, linha, JSON_SAIDA } from './comum.mjs';

const FPS = 60;
const SEGUNDOS = 10;
const QUADROS = FPS * SEGUNDOS;
/** 12 Mbps / 60 fps ≈ 25 KB por quadro P. IDR a cada 2 s ≈ 150 KB. */
const B_P = 25_000;
const B_IDR = 150_000;

function quadro(q) {
  const b = new ArrayBuffer(q % 120 === 0 ? B_IDR : B_P);
  new Uint8Array(b).fill(q & 0xff);
  return b;
}

cabecalho(`Cópias por sender — ${SEGUNDOS} s a ${FPS} fps, ${fmt(B_P / 1000, 0)} KB por quadro P, IDR de ${fmt(B_IDR / 1000, 0)} KB a cada 2 s`);

const quadros = Array.from({ length: QUADROS }, (_, q) => quadro(q));
const bytesPorSegundo = quadros.reduce((s, b) => s + b.byteLength, 0) / SEGUNDOS;

if (!JSON_SAIDA) {
  console.log(`bytes do codificador: ${fmt(bytesPorSegundo / 1e6, 2)} MB/s (${fmt((bytesPorSegundo * 8) / 1e6, 1)} Mbps)\n`);
  console.log(' N   slice(0) por sender (ms / 10 s)   ms por segundo   MB/s copiados   % de um núcleo');
}
for (const n of [1, 5, 20, 50]) {
  const m = medir(() => {
    let soma = 0;
    for (const real of quadros) {
      for (let i = 0; i < n; i += 1) {
        const copia = real.slice(0);
        soma += copia.byteLength;
      }
    }
    return soma;
  });
  const msPorSegundo = m.medianaMs / SEGUNDOS;
  if (!JSON_SAIDA) {
    console.log(
      `${String(n).padStart(2)}   ${fmt(m.medianaMs).padStart(30)}   ${fmt(msPorSegundo).padStart(14)}   ${fmt((bytesPorSegundo * n) / 1e6, 1).padStart(13)}   ${fmt(msPorSegundo / 10, 2).padStart(13)}%`,
    );
  }
  linha({ bench: 'copias-por-sender/slice', n, ms10s: m.medianaMs, msPorSegundo, mbPorSegundo: (bytesPorSegundo * n) / 1e6 });
}

/* ─────────────────────────── clone estruturado vs transferência ─────────────────────────── */

if (!JSON_SAIDA) console.log('\nstructuredClone de um ArrayBuffer de 25 KB × 600 (um quadro por quadro, 10 s):');
{
  const clone = medir(() => {
    let soma = 0;
    for (let q = 0; q < QUADROS; q += 1) {
      const b = new ArrayBuffer(B_P);
      soma += structuredClone(b).byteLength;
    }
    return soma;
  });
  const transf = medir(() => {
    let soma = 0;
    for (let q = 0; q < QUADROS; q += 1) {
      const b = new ArrayBuffer(B_P);
      soma += structuredClone(b, { transfer: [b] }).byteLength;
    }
    return soma;
  });
  if (!JSON_SAIDA) {
    console.log(`  sem transferência (como injecao.mjs hoje): ${fmt(clone.medianaMs)} ms  (${fmt((clone.medianaMs * 1000) / QUADROS, 0)} µs/quadro)`);
    console.log(`  com transferência:                        ${fmt(transf.medianaMs)} ms  (${fmt((transf.medianaMs * 1000) / QUADROS, 0)} µs/quadro)`);
  }
  linha({ bench: 'copias-por-sender/structuredClone', cloneMs: clone.medianaMs, transferMs: transf.medianaMs });
}

/* ─────────────────────────── pressão de alocação: N buffers por quadro ─────────────────────────── */

if (!JSON_SAIDA) console.log('\nalocação: N × new ArrayBuffer(25 KB) por quadro, 600 quadros, com GC forçado entre repetições:');
for (const n of [5, 50]) {
  const m = medir(() => {
    let vivo = null;
    for (let q = 0; q < QUADROS; q += 1) {
      for (let i = 0; i < n; i += 1) vivo = new ArrayBuffer(B_P);
    }
    return vivo;
  });
  if (!JSON_SAIDA) console.log(`  N=${String(n).padStart(2)}: ${fmt(m.medianaMs)} ms / 10 s  (${fmt(m.medianaMs / SEGUNDOS)} ms/s, ${fmt((n * B_P * FPS) / 1e6, 0)} MB/s alocados)`);
  linha({ bench: 'copias-por-sender/alocacao', n, ms10s: m.medianaMs });
}
