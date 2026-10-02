/**
 * Estudo 2 (topologia) — malha pura contra árvore de repasse por espectadores,
 * com subidas heterogêneas SORTEADAS. Calculadora, sem navegador.
 *
 *   node e2e/bench/estudo-topologia.mjs                  # grade padrão (N=20,50; 4 subidas de host; 3 distribuições)
 *   node e2e/bench/estudo-topologia.mjs --dmax=3 --salto=40 --salas=2000
 *   node e2e/bench/estudo-topologia.mjs --json           # linhas JSON para outras ferramentas
 *
 * Complementa `docs/engenharia/estudo/2-transporte-e-topologia.md` §4 e
 * `docs/engenharia/complexidade.md` §D (que usa graus fixos 10/20/50/100/300).
 * Aqui a diferença é a DISTRIBUIÇÃO: sorteamos salas, não só uma mistura fixa.
 *
 * O que o modelo faz:
 *   - b é UM só para a árvore inteira (R5, encode-once): cada aresta carrega
 *     uma cópia do stream. Um nó com subida bruta u banca
 *     k = ⌊(0,75·u − 141 kbps)/b⌋ cópias (mesma folga e reserva de áudio do
 *     produto).
 *   - A árvore de profundidade mínima põe os maiores k mais perto da raiz
 *     (BFS por k decrescente). Com profundidade máxima Dmax, procura-se o MAIOR
 *     b (da escada real: teto, ponto médio e piso de cada degrau) para o qual
 *     todos os N cabem.
 *   - Latência extra = profundidade × h (h = salto, 40 ms, faixa 25–60).
 *
 * O que o modelo NÃO faz: perda, Wi-Fi, CPU do repassador, o custo de manter
 * pais reservas, nem a dinâmica de entrada/saída (ver o simulador, §5 do estudo).
 */
import { sobTsx, RAIZ, W, args, fmt, JSON_SAIDA } from './comum.mjs';
import { join } from 'node:path';

sobTsx(import.meta.url);

const { PRESETS, PRESET_ORDER, pisoDeBitrate, tetoDeBitrate, P2P_LIMITS } = await import(
  join(RAIZ, 'packages/shared/src/encoding.ts')
);
const { presetParaOrcamento } = await import(W('core/media/presets.ts'));

const FOLGA = P2P_LIMITS.uplinkHeadroom;
const AUDIO = 141_000;
const DMAX = Number(args['dmax'] ?? 3);
const SALTO_MS = Number(args['salto'] ?? 40);
const SALAS = Number(args['salas'] ?? 1000);
const MIN_RELE = Number(args['min-rele'] ?? 25); // Mbps: abaixo disto o espectador nunca é candidato a repassador
const FOLGA_RELE = Number(args['folga-rele'] ?? 0.5); // fração da subida de um espectador que ele cede ao repasse (o resto é do jogo dele e da call)
const K_MAX = Number(args['kmax'] ?? 6); // filhos por repassador (protege CPU e o link do próprio jogador)
const TENURE_MIN = Number(args['permanencia'] ?? 45); // minutos de permanência média de um espectador na sala
const Us = [10, 50, 100, 300];
const Ns = [20, 50];

/**
 * DISTRIBUIÇÕES DE SUBIDA BRUTA (Mbps) — PREMISSA, não dado.
 *
 * O que tem fonte: Ookla (dez/2025) mediana de banda larga fixa do Brasil
 * ~222 Mbps de download; Anatel: ~66 % dos acessos fixos são fibra, velocidade
 * contratada média 447 Mbps (2024). O que NÃO tem fonte: a razão de upload.
 * Planos de operadoras grandes costumam dar ~50 % do download; provedores
 * regionais em GPON dão simétrico; cabo/ADSL e 4G ficam em 5–20 Mbps. Os
 * pesos abaixo são a nossa leitura, e as três cobrem o intervalo plausível.
 */
const DISTRIBUICOES = {
  tipica: [[10, 0.15], [25, 0.2], [50, 0.3], [100, 0.25], [300, 0.1]],
  pobre: [[10, 0.4], [25, 0.25], [50, 0.2], [100, 0.1], [300, 0.05]],
  fibra: [[10, 0.05], [25, 0.1], [50, 0.25], [100, 0.4], [300, 0.2]],
};

function rng(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sortear(dist, r) {
  const x = r();
  let acc = 0;
  for (const [u, p] of dist) {
    acc += p;
    if (x < acc) return u;
  }
  return dist[dist.length - 1][0];
}
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)];
};
const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Candidatos a b: teto, ponto médio e piso de cada degrau, do maior para o menor. */
const CANDIDATOS = (() => {
  const l = [];
  for (const id of PRESET_ORDER) {
    const p = PRESETS[id];
    const teto = tetoDeBitrate(p.width, p.height, 60);
    const piso = pisoDeBitrate(p.width, p.height, 60);
    l.push(teto, (teto + piso) / 2, piso);
  }
  return l.sort((a, b) => b - a);
})();
const PISO_FUNDO = pisoDeBitrate(PRESETS['p360p60'].width, PRESETS['p360p60'].height, 60);

const util = (uMbps) => Math.max(0, FOLGA * uMbps * 1e6 - AUDIO);
/** Repassador: fração menor da subida e no máximo K_MAX filhos. */
const utilRele = (uMbps) => Math.max(0, FOLGA_RELE * uMbps * 1e6 - AUDIO);
const grauRele = (u, b) => (u >= MIN_RELE ? Math.min(K_MAX, Math.floor(utilRele(u) / b)) : 0);

/** Malha pura: cada um dos N recebe (0,75·U − áudio)/N, gasto até o teto do degrau. */
function malha(uHost, N) {
  const orc = util(uHost) / N;
  const id = presetParaOrcamento(orc, 'fluidez');
  const p = PRESETS[id];
  const gasto = Math.min(orc, tetoDeBitrate(p.width, p.height, 60));
  return { b: gasto, id, abaixoDoFundo: gasto < PISO_FUNDO };
}

/**
 * Cabe em profundidade <= dmax com b? BFS por grau decrescente.
 * Devolve { ok, d, niveis, repassadores } ou { ok:false }.
 */
function cabe(uHost, us, b, dmax) {
  const kHost = Math.floor(util(uHost) / b);
  const graus = us.map((u) => grauRele(u, b)).sort((a, c) => c - a);
  let vagas = kHost;
  let i = 0;
  const niveis = [];
  let repassadores = 0;
  for (let d = 1; d <= dmax; d += 1) {
    if (vagas <= 0) return { ok: false };
    const nivel = graus.slice(i, i + vagas);
    i += nivel.length;
    niveis.push(nivel.length);
    // quem fica no último nível permitido não precisa repassar
    vagas = d < dmax ? nivel.reduce((a, c) => a + c, 0) : 0;
    if (i >= graus.length) {
      // conta quem de fato repassa: nós com filhos no nível seguinte
      return { ok: true, d, niveis, kHost, graus: graus.slice() };
    }
  }
  return { ok: false };
}

/** O maior b da escada para o qual a sala cabe em Dmax, ou null. */
function melhorArvore(uHost, us, dmax) {
  for (const b of CANDIDATOS) {
    if (b < PISO_FUNDO) break;
    const r = cabe(uHost, us, b, dmax);
    if (r.ok) return { b, ...r };
  }
  return null;
}

/**
 * Constrói a árvore explícita (quem é filho de quem) para medir o tamanho das
 * subárvores. Preenche cada nível com os de maior grau primeiro, e distribui
 * os filhos do nível seguinte entre os repassadores do nível atual, sem passar
 * do grau de cada um (balanceando por menor carga relativa).
 */
function construir(uHost, us, b) {
  const n = us.length;
  const grau = us.map((u) => grauRele(u, b));
  const ordem = [...Array(n).keys()].sort((a, c) => grau[c] - grau[a]);
  const pai = new Array(n).fill(-1);
  const filhos = Array.from({ length: n }, () => []);
  const nivel = new Array(n).fill(0);
  let fila = [{ id: -1, vagas: Math.floor(util(uHost) / b) }];
  let i = 0;
  let d = 0;
  while (i < n && fila.length > 0) {
    d += 1;
    const proximo = [];
    let k = 0;
    // distribui em rodízio entre quem tem vaga, para balancear
    const vagasAtuais = fila.map((f) => f.vagas);
    let restante = vagasAtuais.reduce((a, c) => a + c, 0);
    if (restante === 0) break;
    while (i < n && restante > 0) {
      const f = fila[k % fila.length];
      const idx = k % fila.length;
      if (vagasAtuais[idx] > 0) {
        const v = ordem[i];
        i += 1;
        pai[v] = f.id;
        nivel[v] = d;
        if (f.id >= 0) filhos[f.id].push(v);
        vagasAtuais[idx] -= 1;
        restante -= 1;
        proximo.push({ id: v, vagas: grau[v] });
      }
      k += 1;
    }
    fila = proximo.filter((x) => x.vagas > 0);
  }
  return { pai, filhos, nivel, grau, colocados: i };
}

function tamanhoSubarvore(v, filhos) {
  let t = 1;
  for (const f of filhos[v]) t += tamanhoSubarvore(f, filhos);
  return t;
}

/** r* = min{u_s, (u_s + Σu_i)/N} (Kumar, Liu & Ross, INFOCOM 2007), em bits/s. */
function rEstrela(uHost, us) {
  const uS = util(uHost);
  const soma = us.reduce((a, u) => a + utilRele(u), 0);
  return Math.min(uS, (uS + soma) / us.length);
}

const linhas = [];
for (const [nomeDist, dist] of Object.entries(DISTRIBUICOES)) {
  for (const N of Ns) {
    for (const U of Us) {
      const r = rng(1000 + N * 31 + U);
      const bMalha = [];
      const bArv = [];
      const bEstrela = [];
      const profundidades = [];
      const nRepass = [];
      const hostUsado = [];
      const grandeSubarvore = [];
      const downPorHora = [];
      let semSolucao = 0;
      let malhaAfoga = 0;
      let arvoreAfoga = 0;
      for (let s = 0; s < SALAS; s += 1) {
        const us = Array.from({ length: N }, () => sortear(dist, r));
        const m = malha(U, N);
        bMalha.push(m.b);
        if (m.abaixoDoFundo) malhaAfoga += 1;
        bEstrela.push(rEstrela(U, us));
        const t = melhorArvore(U, us, DMAX);
        if (t === null) {
          semSolucao += 1;
          // sem árvore que caiba: a sala fica na malha (melhor que nada)
          bArv.push(m.b);
          if (m.abaixoDoFundo) arvoreAfoga += 1;
          continue;
        }
        // a malha pura é a árvore de profundidade 1: nunca é pior que ela
        const efetivo = Math.max(t.b, m.abaixoDoFundo ? 0 : m.b);
        bArv.push(Math.max(t.b, m.b));
        profundidades.push(t.d);
        const ex = construir(U, us, t.b);
        const internos = ex.filhos.map((f, i) => (f.length > 0 ? i : -1)).filter((i) => i >= 0);
        nRepass.push(internos.length);
        hostUsado.push(Math.min(N, Math.floor(util(U) / t.b)) * t.b);
        const tams = internos.map((i) => tamanhoSubarvore(i, ex.filhos));
        grandeSubarvore.push(tams.length > 0 ? Math.max(...tams) : 0);
        // falhas: cada repassador sai a taxa 1/permanência; afeta sua subárvore inteira
        const lambda = 1 / (TENURE_MIN * 60); // por segundo, por repassador
        const afetados = tams.reduce((a, c) => a + c, 0) * lambda * 3600; // viewer-eventos por hora (soma)
        downPorHora.push({ eventosPorViewerHora: afetados / N });
        void efetivo;
      }
      const piso720 = pisoDeBitrate(PRESETS['p720p60'].width, PRESETS['p720p60'].height, 60);
      const linha = {
        dist: nomeDist,
        N,
        U,
        mediana_malha: med(bMalha) / 1e6,
        p10_malha: pct(bMalha, 0.1) / 1e6,
        mediana_arvore: med(bArv) / 1e6,
        p10_arvore: pct(bArv, 0.1) / 1e6,
        r_estrela: med(bEstrela) / 1e6,
        malha_afoga_pct: (100 * malhaAfoga) / SALAS,
        arvore_afoga_pct: (100 * arvoreAfoga) / SALAS,
        sem_solucao_pct: (100 * semSolucao) / SALAS,
        arv_720p_pct: (100 * bArv.filter((x) => x >= piso720).length) / SALAS,
        malha_720p_pct: (100 * bMalha.filter((x) => x >= piso720).length) / SALAS,
        prof_mediana: med(profundidades),
        repassadores_mediana: med(nRepass),
        host_usado_mediana: med(hostUsado) / 1e6,
        maior_subarvore_mediana: med(grandeSubarvore),
        eventos_por_viewer_hora: med(downPorHora.map((x) => x.eventosPorViewerHora)),
      };
      linhas.push(linha);
    }
  }
}

if (JSON_SAIDA) {
  for (const l of linhas) console.log(JSON.stringify(l));
} else {
  console.log(`\nMALHA x ÁRVORE DE REPASSE — ${SALAS} salas sorteadas por célula, profundidade máx. ${DMAX}, salto ${SALTO_MS} ms, relé só com subida >= ${MIN_RELE} Mbps, cede ${FOLGA_RELE * 100}% da subida, até ${K_MAX} filhos`);
  console.log('b em Mbps por espectador (UM valor para a sala inteira). 720p60 = piso 6,2 Mbps. "afoga" = abaixo do piso de 360p60 (1,9 Mbps).');
  console.log('dist    N   U(host) | malha med  p10   afoga% 720p% | árvore med  p10  afoga% 720p% semsol% | r* med | prof  rep  host(Mbps)  maior subárv. | +lat(ms)  quedas/espect./h');
  for (const l of linhas) {
    console.log(
      `${l.dist.padEnd(7)} ${String(l.N).padStart(2)}  ${String(l.U).padStart(5)}   | ${fmt(l.mediana_malha, 1).padStart(8)} ${fmt(l.p10_malha, 1).padStart(5)} ${fmt(l.malha_afoga_pct, 0).padStart(6)} ${fmt(l.malha_720p_pct, 0).padStart(5)} | ${fmt(l.mediana_arvore, 1).padStart(10)} ${fmt(l.p10_arvore, 1).padStart(5)} ${fmt(l.arvore_afoga_pct, 0).padStart(6)} ${fmt(l.arv_720p_pct, 0).padStart(5)} ${fmt(l.sem_solucao_pct, 0).padStart(6)} | ${fmt(l.r_estrela, 1).padStart(6)} | ${fmt(l.prof_mediana, 0).padStart(4)} ${fmt(l.repassadores_mediana, 0).padStart(4)} ${fmt(l.host_usado_mediana, 1).padStart(10)} ${fmt(l.maior_subarvore_mediana, 0).padStart(12)} | ${fmt(l.prof_mediana * SALTO_MS, 0).padStart(7)} ${fmt(l.eventos_por_viewer_hora, 2).padStart(10)}`,
    );
  }
  console.log(`\n"quedas/espect./h" = quantas vezes por hora, em média, um espectador perde a fonte porque um ancestral saiu (permanência média ${TENURE_MIN} min, 1/permanência por repassador). Multiplique pelo tempo de religação (0,5 s com pai reserva; 3–5 s sem) para o tempo sem imagem.`);
  console.log('"semsol%" = salas em que NENHUM b >= 1,9 Mbps cabe em profundidade <= Dmax: ficam na malha (a porta da ADR 0030 decide quem entra).');
}
