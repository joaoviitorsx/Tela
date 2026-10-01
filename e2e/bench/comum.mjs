/**
 * Utilidades dos micro-benchmarks de `e2e/bench/`.
 *
 * Não é suíte de teste: é bancada. Cada script mede UM caminho quente do
 * produto contra a alternativa proposta em `docs/engenharia/complexidade.md`,
 * com a mesma disciplina do simulador (ADR 0019): mediana de várias
 * repetições, máquina identificada, e o que não dá para medir aqui fica
 * escrito como "medir em navegador".
 *
 *   node e2e/bench/<nome>.bench.mjs            # relatório no terminal
 *   node e2e/bench/<nome>.bench.mjs --json     # uma linha JSON por medição
 *   node e2e/bench/<nome>.bench.mjs --reps=9   # repetições (padrão 7)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cpus, totalmem, release, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const W = (p) => join(RAIZ, 'apps/web/src', p);

export const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
export const REPS = Number(args['reps'] ?? 7);
export const JSON_SAIDA = args['json'] === true;

function acharTsx() {
  const diretos = [
    join(RAIZ, 'node_modules/tsx/dist/esm/index.mjs'),
    join(RAIZ, 'apps/web/node_modules/tsx/dist/esm/index.mjs'),
  ];
  for (const p of diretos) if (existsSync(p)) return p;
  const store = join(RAIZ, 'node_modules/.pnpm');
  if (!existsSync(store)) return null;
  const candidatos = readdirSync(store).filter((n) => n.startsWith('tsx@')).sort().reverse();
  for (const nome of candidatos) {
    const p = join(store, nome, 'node_modules/tsx/dist/esm/index.mjs');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Re-executa o script sob o loader do `tsx` para importar o TypeScript REAL de
 * `apps/web/src` (mesmo truque de `e2e/malhas.sim.mjs`). Diferente do
 * simulador, NÃO faz build de `@tela/shared`: usa o `dist/` que já existe,
 * para não tocar na árvore enquanto outros trabalham nela.
 */
export function sobTsx(url) {
  if (process.env['BENCH_SOB_TSX'] === '1') return;
  const loader = acharTsx();
  if (loader === null) {
    console.error('Não achei o loader do tsx. Rode `pnpm install` na raiz.');
    process.exit(2);
  }
  if (!existsSync(join(RAIZ, 'packages/shared/dist/index.js'))) {
    console.error('Falta `packages/shared/dist`. Rode `pnpm --filter @tela/shared build` uma vez.');
    process.exit(2);
  }
  const filho = spawnSync(
    process.execPath,
    ['--import', loader, '--expose-gc', fileURLToPath(url), ...process.argv.slice(2)],
    { cwd: RAIZ, stdio: 'inherit', env: { ...process.env, BENCH_SOB_TSX: '1' } },
  );
  process.exit(filho.status ?? 1);
}

export function infoMaquina() {
  const c = cpus();
  return {
    cpu: c[0]?.model?.trim() ?? '?',
    nucleos: c.length,
    ramGiB: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    so: `${process.platform} ${release()} ${arch()}`,
  };
}

export function mediana(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Executa `fn()` `reps` vezes (mais uma de aquecimento, descartada) e devolve
 * a mediana, o mínimo e o máximo em milissegundos. `fn` deve devolver um valor
 * qualquer para o JIT não eliminar o trabalho; o último é devolvido.
 */
export function medir(fn, reps = REPS) {
  let sentinela = fn(); // aquecimento
  const tempos = [];
  for (let i = 0; i < reps; i += 1) {
    if (typeof globalThis.gc === 'function') globalThis.gc();
    const t0 = process.hrtime.bigint();
    sentinela = fn();
    const t1 = process.hrtime.bigint();
    tempos.push(Number(t1 - t0) / 1e6);
  }
  return { medianaMs: mediana(tempos), minMs: Math.min(...tempos), maxMs: Math.max(...tempos), reps, sentinela };
}

export function fmt(n, casas = 2) {
  return Number(n).toFixed(casas).replace('.', ',');
}

export function cabecalho(titulo) {
  if (JSON_SAIDA) return;
  const m = infoMaquina();
  console.log(`\n${titulo}`);
  console.log(`${m.cpu} · ${m.nucleos} threads · ${m.ramGiB} GiB · Node ${m.node} · ${m.so}`);
  console.log(`mediana de ${REPS} repetições (mais 1 de aquecimento), GC forçado entre elas\n`);
}

export function linha(obj) {
  if (JSON_SAIDA) console.log(JSON.stringify({ ...obj, maquina: infoMaquina() }));
}

/** Gerador determinístico (mulberry32) para cenários reproduzíveis. */
export function rng(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
