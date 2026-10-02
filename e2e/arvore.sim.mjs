/**
 * A árvore de repasse REAL (`ArvoreDeRepasse`, ADR 0031) sob uma hora de sala.
 *
 * `cascata.sim.mjs` decidiu SE a cascata vale a pena, com uma árvore ideal.
 * Este roda a classe do produto — os mesmos prazos, folgas, bloqueios e o
 * mesmo "um filho por tique" — contra o que a sala real faz com ela:
 *
 *   - gente entra e sai (permanência exponencial, média 45 min; a cadeira é
 *     reocupada ~30 s depois);
 *   - a aresta entre dois espectadores fecha ou não, por PAR (o NAT dos
 *     dois), com probabilidade `--ice` (padrão 0,8; o pior caso é CGNAT);
 *   - o repassador tem a subida sorteada (distribuição "típica" do estudo 2)
 *     e, de ~10 em ~10 min, uma rajada de 20 s com metade dela (jogo, call);
 *   - o orçamento por caminho do anfitrião é `0,75 × U / caminhos de vídeo`,
 *     com teto no 1080p60 — o que a malha coletiva entregaria.
 *
 * Mede, por espectador-hora: segundos com a imagem parada (volta ao anfitrião
 * congela ~1,1 s, medido no e2e), trocas de fonte, e o orçamento por caminho
 * contra a malha pura (todos diretos). E procura estado absorvente: "a malha
 * não basta, há candidato, e nada liga por mais de 2 min".
 *
 *   node e2e/arvore.sim.mjs              (tabela)
 *   node e2e/arvore.sim.mjs --portao     (sai 1 se algum portão falhar)
 *   node e2e/arvore.sim.mjs --ice=0.5
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..');

function acharTsx() {
  for (const p of [join(RAIZ, 'node_modules/tsx/dist/esm/index.mjs'), join(RAIZ, 'apps/web/node_modules/tsx/dist/esm/index.mjs')]) {
    if (existsSync(p)) return p;
  }
  const store = join(RAIZ, 'node_modules/.pnpm');
  if (!existsSync(store)) return null;
  for (const nome of readdirSync(store).filter((n) => n.startsWith('tsx@')).sort().reverse()) {
    const p = join(store, nome, 'node_modules/tsx/dist/esm/index.mjs');
    if (existsSync(p)) return p;
  }
  return null;
}

if (process.env['SIM_SOB_TSX'] !== '1') {
  const loader = acharTsx();
  if (loader === null) {
    console.error('Não achei o loader do tsx. Rode `pnpm install` na raiz.');
    process.exit(2);
  }
  const build = spawnSync('pnpm', ['--filter', '@tela/shared', 'build'], { cwd: RAIZ, stdio: 'ignore' });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const filho = spawnSync(process.execPath, ['--import', loader, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: RAIZ,
    stdio: 'inherit',
    env: { ...process.env, SIM_SOB_TSX: '1' },
  });
  process.exit(filho.status ?? 1);
}

const { ArvoreDeRepasse, LIMIAR_DO_REPASSE_BPS } = await import(join(RAIZ, 'apps/web/src/core/mesh/arvore-de-repasse.ts'));

const arg = (nome, padrao) => {
  const a = process.argv.find((x) => x.startsWith(`--${nome}=`));
  return a === undefined ? padrao : Number(a.split('=')[1]);
};
const PORTAO = process.argv.includes('--portao');
const ICE = arg('ice', 0.8);
const SEMENTES = arg('sementes', 3);
const DURACAO_S = 3600;
const AQUECIMENTO_S = 180;
/** Teto útil do 1080p60 por caminho (vídeo), como na escada real. */
const TETO_BPS = 16_000_000;
/** Volta ao anfitrião: imagem parada ~1,1 s (e2e/repasse.e2e.mjs). */
const VOLTA_S = 1.1;
/** Vigia do filho antes do sem-pai. */
const VIGIA_S = 0.7;

function rng(semente) {
  let s = semente >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "Típica" do estudo 2 §4.3, em bits/s. */
function subida(r) {
  const x = r();
  const mbps = x < 0.15 ? 10 : x < 0.35 ? 25 : x < 0.65 ? 50 : x < 0.9 ? 100 : 300;
  return mbps * 1e6;
}

function hashPar(a, b, semente) {
  const s = a < b ? `${a}|${b}` : `${b}|${a}`;
  let h = 2166136261 ^ semente;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

function simular({ n, uHost, semente }) {
  const r = rng(semente * 7919 + n * 131 + Math.round(uHost / 1e6));
  let agora = 0;
  const pessoas = new Map(); // id → { podeRepassar, u, rtt, sai, rajadaAte, proximaRajada, pai, confirmado }
  const agenda = []; // { t, f }
  const em = (t, f) => agenda.push({ t, f });
  let seq = 0;
  const m = { parado: 0, trocas: 0, espectadorS: 0, diretosS: 0, bCascata: [], bMalha: [], absorvente: 0, precisaSemLigar: 0 };

  const arvore = new ArvoreDeRepasse({
    agora: () => agora * 1000,
    pausarVideo: () => undefined,
    enviar: (msg, para) => {
      const p = pessoas.get(para);
      if (p === undefined) return;
      if (msg.repasse === 'pai') {
        if (msg.pai === null) {
          if (p.confirmado && p.pai !== null) {
            m.parado += VOLTA_S;
            m.trocas += 1;
          }
          p.pai = null;
          p.confirmado = false;
          return;
        }
        p.pai = msg.pai;
        p.confirmado = false;
        const pai = msg.pai;
        // A aresta fecha por PAR: o mesmo par falha sempre (o NAT dos dois).
        if (hashPar(para, pai, semente) < ICE) {
          em(agora + 0.5 + r() * 2, () => {
            const q = pessoas.get(para);
            if (q === undefined || q.pai !== pai) return;
            q.confirmado = true;
            m.trocas += 1;
            arvore.receber(para, { repasse: 'com-pai' });
          });
        }
      }
    },
  });

  const entrar = () => {
    const id = `v${seq++}`;
    const p = {
      podeRepassar: r() < 0.7,
      u: subida(r),
      rtt: 5 + r() * 60,
      sai: agora - Math.log(1 - r()) * 45 * 60,
      rajadaAte: 0,
      proximaRajada: agora + r() * 600,
      pai: null,
      confirmado: false,
    };
    pessoas.set(id, p);
    arvore.receber(id, { repasse: 'estado', versao: 1, podeRepassar: p.podeRepassar, rttMs: p.rtt });
  };
  for (let i = 0; i < n; i += 1) entrar();

  let semLigarDesde = null;
  for (agora = 0; agora < DURACAO_S; agora += 1) {
    agenda.sort((a, b) => a.t - b.t);
    while (agenda.length > 0 && agenda[0].t <= agora) agenda.shift().f();

    // Saídas e reentradas.
    for (const [id, p] of [...pessoas]) {
      if (agora < p.sai) continue;
      pessoas.delete(id);
      // Os filhos dele: imagem parada até voltar ao anfitrião.
      for (const q of pessoas.values()) {
        if (q.pai === id && q.confirmado) {
          m.parado += VIGIA_S;
        }
      }
      arvore.saiu(id);
      em(agora + 30, entrar);
    }

    // O orçamento que a malha coletiva daria aos caminhos diretos.
    const diretos = [...pessoas.values()].filter((p) => !(p.pai !== null && p.confirmado)).length;
    const b = Math.min(TETO_BPS, (0.75 * uHost) / Math.max(1, diretos));
    const bMalha = Math.min(TETO_BPS, (0.75 * uHost) / Math.max(1, pessoas.size));
    arvore.definirOrcamento(b);

    // Repassadores: relatório a cada 2 s; rajadas de jogo/call.
    if (agora % 2 === 0) {
      for (const [id, p] of pessoas) {
        if (agora >= p.proximaRajada) {
          p.rajadaAte = agora + 20;
          p.proximaRajada = agora + 300 + r() * 600;
        }
        const filhos = [...pessoas.entries()].filter(([, q]) => q.pai === id && q.confirmado);
        if (filhos.length === 0) continue;
        const u = agora < p.rajadaAte ? p.u / 2 : p.u;
        const porAresta = (0.5 * u) / filhos.length;
        const leitura = Math.min(1.5 * b, porAresta) * (0.8 + r() * 0.4);
        // Sem banda para todos, a imagem do filho mais novo para: o vigia dele dispara.
        if (porAresta < 0.6 * b && r() < 0.5) {
          const [fid] = filhos[filhos.length - 1];
          m.parado += VIGIA_S;
          arvore.receber(fid, { repasse: 'sem-pai' });
        }
        arvore.receber(id, { repasse: 'relatorio', filhos: filhos.length, piorSaidaBps: leitura, sobrecarregado: false });
      }
      arvore.tique();
    }

    if (agora < AQUECIMENTO_S) continue;
    m.espectadorS += pessoas.size;
    m.diretosS += diretos;
    m.bCascata.push(b);
    m.bMalha.push(bMalha);

    // Absorvente: precisa (orçamento abaixo do limiar), há candidato livre e
    // folha, e a árvore não liga ninguém por 2 min seguidos.
    const precisa = b < LIMIAR_DO_REPASSE_BPS && pessoas.size >= 3;
    const candidatos = [...pessoas.values()].filter((p) => p.podeRepassar && p.pai === null).length;
    const ligados = [...pessoas.values()].filter((p) => p.pai !== null).length;
    if (precisa && candidatos >= 2 && ligados === 0) {
      semLigarDesde ??= agora;
      if (agora - semLigarDesde > 120) m.absorvente += 1;
    } else {
      semLigarDesde = null;
    }
  }

  const horas = m.espectadorS / 3600;
  const mediana = (v) => [...v].sort((a, c) => a - c)[Math.floor(v.length / 2)] ?? 0;
  return {
    paradoPorHora: m.parado / Math.max(1e-9, horas),
    trocasPorHora: m.trocas / Math.max(1e-9, horas),
    caminhos: m.diretosS / Math.max(1, (DURACAO_S - AQUECIMENTO_S)),
    bCascata: mediana(m.bCascata),
    bMalha: mediana(m.bMalha),
    absorvente: m.absorvente,
  };
}

const linhas = [];
let falhas = 0;
for (const n of [10, 20, 50]) {
  for (const uHost of [10e6, 50e6, 100e6, 300e6]) {
    const rodadas = Array.from({ length: SEMENTES }, (_, s) => simular({ n, uHost, semente: s + 1 }));
    const med = (k) => [...rodadas.map((x) => x[k])].sort((a, b) => a - b)[Math.floor(rodadas.length / 2)];
    const l = {
      n,
      u: uHost / 1e6,
      caminhos: med('caminhos'),
      bCascata: med('bCascata') / 1e6,
      bMalha: med('bMalha') / 1e6,
      parado: med('paradoPorHora'),
      trocas: med('trocasPorHora'),
      absorvente: Math.max(...rodadas.map((x) => x.absorvente)),
    };
    linhas.push(l);
  }
}

console.log(`\nÁrvore real sob uma hora de sala · ICE entre pares ${Math.round(ICE * 100)} % · ${SEMENTES} sementes (mediana)\n`);
console.log('   N   host   caminhos diretos   Mbps/caminho cascata | malha   s parado/h   trocas/h   absorvente');
for (const l of linhas) {
  console.log(
    `  ${String(l.n).padStart(2)}  ${String(l.u).padStart(4)}   ${l.caminhos.toFixed(1).padStart(6)} de ${String(l.n).padEnd(4)}     ` +
      `${l.bCascata.toFixed(1).padStart(5)} | ${l.bMalha.toFixed(1).padEnd(5)}       ${l.parado.toFixed(1).padStart(5)}      ${l.trocas.toFixed(1).padStart(5)}      ${l.absorvente}`,
  );
}

/*
  Portões (ADR 0031, fase 2 e ADR 0019):
  - nunca pior que a malha: Mbps por caminho da cascata ≥ o da malha, em toda célula;
  - ≤ 5 s de imagem parada por espectador-hora (alvo da fase 2);
  - nenhum estado absorvente (2 min precisando, com candidato, sem ligar ninguém).
*/
if (PORTAO) {
  console.log('\nPortões');
  const portao = (ok, msg) => {
    console.log(`    ${ok ? 'ok  ' : 'FALHA'} ${msg}`);
    if (!ok) falhas += 1;
  };
  portao(linhas.every((l) => l.bCascata >= l.bMalha - 1e-9), 'cascata nunca entrega menos por caminho que a malha');
  const pior = Math.max(...linhas.map((l) => l.parado));
  portao(pior <= 5, `imagem parada ≤ 5 s por espectador-hora (pior célula: ${pior.toFixed(1)} s)`);
  portao(linhas.every((l) => l.absorvente === 0), 'nenhum estado absorvente');
  process.exit(falhas === 0 ? 0 : 1);
}
