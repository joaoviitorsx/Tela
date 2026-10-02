/**
 * SIMULADOR DA CASCATA DE REPASSE (ADR 0031, proposta).
 *
 * Compara, no tempo, a malha pura com a ADR 0030 (porta pela banda) contra uma
 * árvore de repasse de profundidade <= Dmax em que espectadores com boa subida
 * reinjetam o quadro codificado nos seus filhos, sem recodificar.
 *
 *   node e2e/cascata.sim.mjs                 # grade completa (3 dist x 3 N x 4 U x 2 modos)
 *   node e2e/cascata.sim.mjs --rapido        # 1 repetição, 1200 s: para iterar
 *   node e2e/cascata.sim.mjs --dmax=3        # profundidade máxima (padrão 2: fase 1)
 *   node e2e/cascata.sim.mjs --kmax=4 --cede=0.35 --optin=0.5 --min-rele=25   # sensibilidade, uma por vez
 *   node e2e/cascata.sim.mjs --md            # tabela em Markdown (a que vai na ADR)
 *   node e2e/cascata.sim.mjs --premissas     # só o texto das premissas
 *
 * NÃO é o simulador das malhas (`malhas.sim.mjs`, que roda a sessão REAL). Aqui
 * o governador coletivo é uma versão mínima, feita para o que a cascata
 * pergunta: o que acontece quando o gargalo deixa de ser UM link e passa a ser
 * o pior de uma árvore. Reaproveita o mesmo MODELO DE REDE (AIMD de 8 %/s,
 * tampa de 1,5 x acked + 10 kbps, recuo a 0,85 x enviado, ruído de 20 %,
 * partilha max-min) e a escada REAL de `@tela/shared`, e o mesmo critério de
 * porta da ADR 0030. O que ele NÃO prova: ver `PREMISSAS`, no fim.
 *
 * Saída: tabela no terminal e `e2e/cascata.sim.json` (artefato, no .gitignore).
 * Determinístico: sementes fixas por (dist, N, U, repetição), mesmas para a
 * malha e para a cascata (a mesma sala sorteada nos dois modos).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sobTsx, RAIZ, W, args } from './bench/comum.mjs';

sobTsx(import.meta.url);

const { PRESETS, PRESET_ORDER, pisoDeBitrate, tetoDeBitrate, P2P_LIMITS } = await import(
  join(RAIZ, 'packages/shared/src/encoding.ts')
);
const { presetParaOrcamento } = await import(W('core/media/presets.ts'));

/* ═══════════════════════════════════════════════════════════════════════
   PARÂMETROS
   ═══════════════════════════════════════════════════════════════════════ */

const RAPIDO = args['rapido'] === true;
const DMAX = Number(args['dmax'] ?? 2);
const SEG = Number(args['segundos'] ?? (RAPIDO ? 1200 : 3600));
const REPS = Number(args['reps'] ?? (RAPIDO ? 1 : 3));
const WARM = 180; // s descartados no início das métricas
const AUDIO = 141_000;
const HEADROOM = P2P_LIMITS.uplinkHeadroom; // 0,75: o que o host usa da subida
/** Fração da subida bruta que um repassador PERMITE ao repasse (o resto é do jogo/call). */
const CEDE = Number(args['cede'] ?? 0.5);
/** Capacidade FÍSICA do repasse: com o orçamento de 0,75, dá CEDE no fim. */
const FISICO = CEDE / HEADROOM;
const K_MAX = Number(args['kmax'] ?? 6);
const MIN_RELE = Number(args['min-rele'] ?? 25); // Mbps: abaixo disto nunca é candidato
const OPTIN = Number(args['optin'] ?? 1); // fração dos candidatos que aceita ajudar
const PERMANENCIA = Number(args['permanencia'] ?? 45) * 60; // s, média da sessão de um espectador
const REENTRADA = 30; // s, média até a vaga (cadeira) ser ocupada por outra pessoa
const SALTO_MS = Number(args['salto'] ?? 40); // latência por salto
const RAJADA_TAXA = Number(args['rajada'] ?? 1 / 600); // por s, por repassador: jogo/call come a subida
const RAJADA_DUR = 20;
const RAJADA_FATOR = 0.5;

// Modelo de rede: as mesmas constantes de `malhas.sim.mjs` (Rede.tique).
const AIMD_BETA = 0.85;
const AIMD_SUBIDA = 0.08;
const AIMD_TETO_FATOR = 1.5;
const AIMD_TETO_OFFSET = 10_000;
const BWE_PISO = 30_000;
const RUIDO = 0.2;
const MARGEM_SOBREUSO = 1.02;
const ALFA = 0.25; // suavização da leitura (a mesma média móvel do governador)
const AQUECIMENTO = 8; // amostras antes de um caminho votar (ADR 0030 A)
const ABSURDO = 0.6;
const CORTE = 0.7; // histerese de corte do governador
const PISO_ADMISSAO =
  (pisoDeBitrate(PRESETS['p360p60'].width, PRESETS['p360p60'].height, 60) + AUDIO) * 1.1;
const PISO_FUNDO = pisoDeBitrate(PRESETS['p360p60'].width, PRESETS['p360p60'].height, 60);
const PISO_720 = pisoDeBitrate(PRESETS['p720p60'].width, PRESETS['p720p60'].height, 60);
const TETO_1080 = tetoDeBitrate(PRESETS['p1080p60'].width, PRESETS['p1080p60'].height, 60);
const TETO_PORTA = P2P_LIMITS.maxViewers;

const Ns = [10, 20, 50];
const Us = [10, 50, 100, 300];

/** Distribuições de subida bruta (Mbps): as MESMAS do estudo 2 §4.3 (premissa [A], sem fonte). */
const DISTRIBUICOES = {
  tipica: [[10, 0.15], [25, 0.2], [50, 0.3], [100, 0.25], [300, 0.1]],
  pobre: [[10, 0.4], [25, 0.25], [50, 0.2], [100, 0.1], [300, 0.05]],
  fibra: [[10, 0.05], [25, 0.1], [50, 0.25], [100, 0.4], [300, 0.2]],
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

const pixels = (id) => PRESETS[id].width * PRESETS[id].height;
const tetoDe = (id) => tetoDeBitrate(PRESETS[id].width, PRESETS[id].height, 60);
const pisoDe = (id) => pisoDeBitrate(PRESETS[id].width, PRESETS[id].height, 60);

/* ═══════════════════════════════════════════════════════════════════════
   UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

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
const exp = (media, r) => -media * Math.log(1 - r());
function sortear(dist, r) {
  const x = r();
  let acc = 0;
  for (const [u, p] of dist) {
    acc += p;
    if (x < acc) return u;
  }
  return dist[dist.length - 1][0];
}
const mediana = (xs) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct = (xs, q) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const f = (n, c = 1) => (Number.isFinite(n) ? Number(n).toFixed(c).replace('.', ',') : '—');

/** Partilha max-min de `cap` entre demandas (o `partilhaMaxMin` do simulador de malhas). */
function maxMin(cap, demandas) {
  const n = demandas.length;
  const out = new Array(n).fill(0);
  const ord = [...Array(n).keys()].sort((i, j) => demandas[i] - demandas[j]);
  let resto = cap;
  let faltam = n;
  for (const i of ord) {
    const justo = resto / faltam;
    const d = Math.min(demandas[i], justo);
    out[i] = d;
    resto -= d;
    faltam -= 1;
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   ÁRVORE: grau, construção, viabilidade (as regras do estudo 2 §4.4)
   ═══════════════════════════════════════════════════════════════════════ */

const grauHost = (U, b) => Math.max(0, Math.floor((HEADROOM * U * 1e6 - AUDIO) / b));
const grauRele = (v, b) =>
  v.rele && v.u >= MIN_RELE ? Math.min(K_MAX, Math.max(0, Math.floor((CEDE * v.u * 1e6 - AUDIO) / b))) : 0;

/**
 * BFS por grau decrescente. Devolve `pai` (Map id -> id|'h') ou null se alguém
 * não cabe em profundidade <= dmax. Não muda nada.
 */
function construir(U, viewers, b, dmax) {
  const ord = [...viewers].sort((x, y) => grauRele(y, b) - grauRele(x, b) || y.u - x.u || x.id - y.id);
  const pai = new Map();
  let nivel = [{ id: 'h', vagas: grauHost(U, b) }];
  let i = 0;
  for (let d = 1; d <= dmax && i < ord.length; d += 1) {
    const prox = [];
    const livres = nivel.map((p) => p.vagas);
    let restante = livres.reduce((a, c) => a + c, 0);
    if (restante === 0) return null;
    let k = 0;
    while (i < ord.length && restante > 0) {
      const idx = k % nivel.length;
      if (livres[idx] > 0) {
        const v = ord[i++];
        pai.set(v.id, nivel[idx].id);
        livres[idx] -= 1;
        restante -= 1;
        if (d < dmax) {
          const g = grauRele(v, b);
          if (g > 0) prox.push({ id: v.id, vagas: g });
        }
      }
      k += 1;
    }
    nivel = prox;
  }
  return i >= ord.length ? pai : null;
}

/** O maior b da escada (>= piso do fundo + áudio) para o qual todos cabem, ou null. */
function melhorB(U, viewers, dmax, margem = 0) {
  const todos = viewers.concat(Array.from({ length: margem }, (_, i) => ({ id: -1 - i, u: 0, rele: false })));
  for (const b of CANDIDATOS) {
    if (b < PISO_FUNDO) break;
    if (construir(U, todos, b, dmax) !== null) return b;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
   UMA SALA, UMA RODADA
   ═══════════════════════════════════════════════════════════════════════ */

function simular({ modo, dist, N, U, semente, dmax }) {
  const r = rng(semente);
  const rr = rng(semente ^ 0x9e3779b9); // ruído de leitura: independente da cena
  const cascata = modo === 'cascata';
  const DM = cascata ? dmax : 1;

  /** Uma "cadeira" por espectador que quer assistir; a pessoa nela troca ao longo do tempo. */
  const cadeiras = Array.from({ length: N }, (_, i) => ({
    id: i,
    u: 0,
    rele: false,
    estado: 'fora', // fora | espera | assiste
    chega: r() * 30,
    prox: 0,
    sai: 0,
    pai: null, // 'h' | id | null (órfão)
    filhos: new Set(),
    prof: 0,
    // aresta de entrada
    bwe: 0,
    acked: null,
    sm: null,
    idade: 0,
    sobreuso: false,
    enviado: 0,
    semFonteAte: 0,
    orfaoDesde: -1,
    fatorRajada: 1,
    rajadaAte: 0,
    // contagens
    eventos: 0,
    trocas: 0,
    segSemImagem: 0,
    segAssistindo: 0,
  }));
  const nova = (c, t) => {
    c.u = sortear(DISTRIBUICOES[dist], r);
    c.rele = c.u >= MIN_RELE && r() < OPTIN;
    c.estado = 'espera';
    c.prox = t;
    c.filhos = new Set();
    c.pai = null;
    c.fatorRajada = 1;
    c.rajadaAte = 0;
    c.orfaoDesde = -1;
  };

  let bApl = TETO_1080;
  let ultimaMudanca = -100;
  let sondaEm = 20;
  let sondaEspera = 15;
  let sondaAte = -1;
  let sondaAntes = 0;
  let sondaSobreusos = 0;
  let ultRecon = -1000;
  let reconfigs = 0; // mudanças de b + arestas movidas
  let expulsos = 0;

  // métricas
  const histBpp = [];
  const histProf = [];
  let segsPresentes = 0;
  let segsCadeira = 0;
  let somaHost = 0;
  let somaHostAmostras = 0;
  let segsSemImg = 0;
  let segsAfoga = 0;
  let segsViu = 0;
  let seg720 = 0;
  let segQuad = 0;
  const bAplHist = [];
  let admitidosTempo = 0;

  /** Folga de projeto: a árvore é dimensionada para estes lugares vazios a mais (o host reserva vagas). */
  const MARGEM = Math.max(2, Math.ceil(0.1 * N));
  const bComFolga = (todos) => melhorB(U, todos, DM, MARGEM) ?? melhorB(U, todos, DM, 0);
  const assistindo = () => cadeiras.filter((c) => c.estado === 'assiste');
  const hostFilhos = new Set();

  const capMalha = () => Math.min(TETO_PORTA, Math.max(assistindo().length, Math.floor((HEADROOM * U * 1e6) / PISO_ADMISSAO)));

  function ligar(c, paiId, t, hot) {
    c.pai = paiId;
    c.bwe = bApl;
    c.acked = null;
    c.sm = null;
    c.idade = 0;
    c.sobreuso = false;
    c.enviado = 0;
    c.orfaoDesde = -1;
    if (paiId === 'h') hostFilhos.add(c.id);
    else cadeiras[paiId].filhos.add(c.id);
    if (hot !== undefined) c.semFonteAte = t + hot;
  }
  function desligar(c) {
    if (c.pai === 'h') hostFilhos.delete(c.id);
    else if (c.pai !== null) cadeiras[c.pai].filhos.delete(c.id);
    c.pai = null;
  }
  const trecHost = (t) => 0.7 + 0.5 * r();
  const trecOutro = (t) => 1.2 + 0.8 * r();

  /** Anexados ao host agora (alcançáveis), com profundidade. */
  function anexados() {
    const prof = new Map();
    let nivel = [...hostFilhos];
    let d = 1;
    while (nivel.length > 0) {
      const prox = [];
      for (const id of nivel) {
        prof.set(id, d);
        for (const fl of cadeiras[id].filhos) prox.push(fl);
      }
      nivel = prox;
      d += 1;
    }
    return prof;
  }
  const altura = (id) => {
    let h = 1;
    for (const fl of cadeiras[id].filhos) h = Math.max(h, 1 + altura(fl));
    return h;
  };

  /** Acha um pai com vaga ao b atual; o host primeiro (é o pai reserva). */
  function acharPai(c, anex, bAtual) {
    const alt = altura(c.id);
    if (hostFilhos.size < grauHost(U, bAtual)) return { id: 'h', hot: true };
    let melhor = null;
    for (const [id, d] of anex) {
      if (id === c.id) continue;
      const p = cadeiras[id];
      if (d + alt > DM) continue;
      if (p.estado !== 'assiste') continue;
      if (t_global < p.semFonteAte) continue;
      const g = grauRele(p, bAtual);
      const livre = g - p.filhos.size;
      if (livre <= 0) continue;
      if (melhor === null || d < melhor.d || (d === melhor.d && livre > melhor.livre)) melhor = { id, d, livre };
    }
    return melhor === null ? null : { id: melhor.id, hot: false };
  }
  let t_global = 0;

  function reconstruir(t, bNovo, viewersTodos) {
    const pai = construir(U, viewersTodos, bNovo, DM);
    if (pai === null) return false;
    ultRecon = t;
    for (const v of viewersTodos) {
      const novoPai = pai.get(v.id);
      if (v.pai !== novoPai) {
        // mudar de pai: make-before-break assumido, mas o IDR e a troca custam ~1 s
        const eraAnexado = v.pai !== null;
        desligar(v);
        ligar(v, novoPai, t, 1.0);
        if (eraAnexado) {
          v.trocas += 1;
          reconfigs += 1;
        }
      }
    }
    return true;
  }

  function entrar(c, t) {
    if (!cascata) {
      if (assistindo().length >= capMalha()) return false;
      c.estado = 'assiste';
      c.sai = t + exp(PERMANENCIA, r);
      ligar(c, 'h', t);
      c.semFonteAte = t;
      return true;
    }
    // cascata: tenta colocar ao b atual; senão vê se cabe a um b menor (porta)
    c.estado = 'assiste';
    c.sai = t + exp(PERMANENCIA, r);
    c.filhos = new Set();
    let anex = anexados();
    let pai = acharPai(c, anex, bApl);
    if (pai === null) {
      const todos = assistindo();
      const bCand = bComFolga(todos);
      if (bCand === null) {
        c.estado = 'espera';
        return false;
      }
      const bNovo = Math.min(bApl, bCand);
      if (bNovo < bApl) {
        bApl = bNovo;
        reconfigs += 1;
        ultimaMudanca = t;
      }
      // reconstrói só o que for preciso: tenta primeiro apenas colocar
      anex = anexados();
      pai = acharPai(c, anex, bApl);
      if (pai === null) {
        // refaz a árvore inteira (os que se movem pagam ~1 s)
        const ok = reconstruir(t, bApl, todos.filter((x) => x !== c).concat([c]));
        if (!ok) {
          c.estado = 'espera';
          return false;
        }
        c.semFonteAte = t;
        return true;
      }
    }
    ligar(c, pai.id, t);
    c.semFonteAte = t;
    return true;
  }

  function sair(c, t) {
    // subárvore: cada descendente perde a fonte (um evento cada)
    const orfaos = [...c.filhos];
    desligar(c);
    c.estado = 'fora';
    c.chega = t + exp(REENTRADA, r);
    for (const fid of orfaos) {
      const raiz = cadeiras[fid];
      raiz.pai = null;
      raiz.orfaoDesde = t;
      // todos na subárvore perdem a imagem
      const pilha = [fid];
      while (pilha.length > 0) {
        const x = cadeiras[pilha.pop()];
        x.eventos += 1;
        for (const fl of x.filhos) pilha.push(fl);
      }
    }
    c.filhos = new Set();
  }

  /** Reanexa órfãos; devolve quantos continuam sem pai. */
  function reanexar(t) {
    const orfaos = cadeiras.filter((c) => c.estado === 'assiste' && c.pai === null);
    let sem = 0;
    for (const o of orfaos) {
      const anex = anexados();
      const pai = acharPai(o, anex, bApl);
      if (pai === null) {
        sem += 1;
        continue;
      }
      ligar(o, pai.id, t, pai.hot ? trecHost(t) : trecOutro(t));
      reconfigs += 1;
    }
    return sem;
  }

  /* ───────────────────────── laço de 1 s ───────────────────────── */
  for (let t = 0; t < SEG; t += 1) {
    t_global = t;
    // 1. chegadas, tentativas, saídas
    for (const c of cadeiras) {
      if (c.estado === 'fora' && t >= c.chega) nova(c, t);
      if (c.estado === 'espera' && t >= c.prox) {
        if (!entrar(c, t)) c.prox = t + 15;
      } else if (c.estado === 'assiste' && t >= c.sai) {
        sair(c, t);
      }
    }

    // 2. rajadas de jogo/call nos repassadores (só existem na cascata)
    if (cascata) {
      for (const c of cadeiras) {
        if (c.estado !== 'assiste' || c.filhos.size === 0) continue;
        if (t >= c.rajadaAte) {
          c.fatorRajada = 1;
          if (r() < RAJADA_TAXA) {
            c.rajadaAte = t + RAJADA_DUR;
            c.fatorRajada = RAJADA_FATOR;
          }
        }
        // o host reduz k desse repassador e reparenta o excesso (R5: "ele muda de lugar")
        const kEfetivo = Math.max(0, Math.floor((HEADROOM * FISICO * c.fatorRajada * c.u * 1e6 - AUDIO) / bApl));
        let excesso = c.filhos.size - kEfetivo;
        if (excesso > 0) {
          for (const fid of [...c.filhos].reverse()) {
            if (excesso <= 0) break;
            const fl = cadeiras[fid];
            desligar(fl);
            const anex = anexados();
            const pai = acharPai(fl, anex, bApl);
            if (pai !== null && pai.id !== c.id) {
              ligar(fl, pai.id, t, 0.5);
              reconfigs += 1;
              fl.trocas += 1;
            } else {
              ligar(fl, c.id, t); // nenhum lugar: fica, e a malha desce se a aresta sufocar
            }
            excesso -= 1;
          }
        }
      }
    }

    // 3. rede: BFS a partir do host
    let nivel = [{ id: 'h', cap: U * 1e6, recv: Infinity, filhos: [...hostFilhos] }];
    const matura = [];
    const prof = new Map();
    let d = 1;
    somaHostAmostras += 1;
    while (nivel.length > 0) {
      const prox = [];
      for (const pn of nivel) {
        if (pn.filhos.length === 0) continue;
        const fs = pn.filhos.map((id) => cadeiras[id]);
        const demandas = fs.map((c) => {
          if (t < c.semFonteAte) return 0;
          return Math.min(c.bwe, bApl, pn.recv);
        });
        const fatias = maxMin(pn.cap, demandas);
        fs.forEach((c, i) => {
          prof.set(c.id, d);
          c.prof = d;
          const dem = demandas[i];
          const parado = t < c.semFonteAte || pn.recv < 1;
          if (parado) {
            c.enviado = 0;
            c.sobreuso = false;
          } else {
            const enviado = Math.min(dem, fatias[i]);
            c.sobreuso = dem > fatias[i] * MARGEM_SOBREUSO;
            c.acked = enviado;
            c.enviado = enviado;
            if (c.sobreuso) c.bwe = AIMD_BETA * enviado;
            else c.bwe = c.bwe * (1 + AIMD_SUBIDA) + 1_000;
            c.bwe = Math.max(BWE_PISO, Math.min(c.bwe, AIMD_TETO_FATOR * enviado + AIMD_TETO_OFFSET));
            const leitura = Math.max(BWE_PISO, c.bwe * (1 + (rr() * 2 - 1) * RUIDO));
            c.sm = c.sm === null ? leitura : c.sm + ALFA * (leitura - c.sm);
            c.idade += 1;
            matura.push(c);
          }
          if (d < DM && c.filhos.size > 0) {
            prox.push({
              id: c.id,
              cap: FISICO * c.u * 1e6 * c.fatorRajada,
              recv: parado ? 0 : c.enviado,
              filhos: [...c.filhos],
            });
          }
        });
      }
      nivel = prox;
      d += 1;
    }
    {
      let h = 0;
      for (const id of hostFilhos) h += cadeiras[id].enviado;
      somaHost += h;
    }

    // 4. governador coletivo
    const votantes = [];
    let algumSobreuso = false;
    for (const c of matura) {
      if (c.sobreuso) algumSobreuso = true;
      if (c.idade >= AQUECIMENTO || c.sm < ABSURDO * bApl) votantes.push(0.75 * c.sm);
    }
    // bTeto: o que a árvore paga a b atual (continuo): menor orçamento/filhos entre os pais
    const ceilTeto = (() => {
      let c = TETO_1080;
      if (!cascata) return c;
      if (hostFilhos.size > 0) c = Math.min(c, (HEADROOM * U * 1e6 - AUDIO) / hostFilhos.size);
      for (const x of cadeiras) {
        if (x.estado === 'assiste' && x.filhos.size > 0) c = Math.min(c, (CEDE * x.u * 1e6 - AUDIO) / x.filhos.size);
      }
      return c;
    })();
    if (votantes.length > 0 && t - ultimaMudanca >= 5) {
      const minOrc = Math.min(...votantes);
      if (sondaAte >= 0) {
        if (algumSobreuso) sondaSobreusos += 1;
        if (t >= sondaAte) {
          if (sondaSobreusos >= 3) {
            bApl = sondaAntes; // a sonda que falha volta para onde estava
            sondaEspera = Math.min(240, sondaEspera * 2);
            reconfigs += 1;
          } else {
            sondaEspera = 15;
          }
          sondaAte = -1;
          sondaEm = t + sondaEspera;
          ultimaMudanca = t;
        }
      } else if (minOrc < CORTE * bApl) {
        const id = presetParaOrcamento(minOrc, 'fluidez');
        bApl = Math.max(200_000, Math.min(minOrc, tetoDe(id)));
        reconfigs += 1;
        ultimaMudanca = t;
        sondaEm = Math.max(sondaEm, t + sondaEspera);
      } else if (bApl < Math.min(TETO_1080, ceilTeto) - 1 && minOrc >= 1.1 * bApl) {
        const id = presetParaOrcamento(bApl, 'fluidez');
        let novo = Math.min(bApl * 1.06, tetoDe(id));
        if (bApl >= tetoDe(id) - 1) {
          const i = PRESET_ORDER.indexOf(id);
          if (i > 0 && minOrc >= pisoDe(PRESET_ORDER[i - 1])) novo = pisoDe(PRESET_ORDER[i - 1]);
        }
        novo = Math.min(novo, ceilTeto, TETO_1080);
        if (novo > bApl + 1) {
          bApl = novo;
          reconfigs += 1;
          ultimaMudanca = t;
        }
      } else if (t >= sondaEm && bApl < Math.min(TETO_1080, ceilTeto) - 1) {
        const id = presetParaOrcamento(bApl, 'fluidez');
        let novo = Math.min(bApl * 1.2, tetoDe(id));
        if (bApl >= tetoDe(id) - 1) {
          const i = PRESET_ORDER.indexOf(id);
          if (i > 0) novo = pisoDe(PRESET_ORDER[i - 1]);
        }
        novo = Math.min(novo, ceilTeto, TETO_1080);
        if (novo > bApl + 1) {
          sondaAntes = bApl;
          bApl = novo;
          sondaAte = t + 8;
          sondaSobreusos = 0;
          ultimaMudanca = t;
        } else sondaEm = t + sondaEspera;
      }
    }

    // 5. cascata: reanexar órfãos, reconstruir, reequilibrar
    if (cascata) {
      const sem = reanexar(t);
      if (sem > 0) {
        const todos = assistindo();
        const demora = todos.some((c) => c.pai === null && t - c.orfaoDesde > 3);
        if (demora && t - ultRecon >= 10) {
          const bCand = bComFolga(todos);
          if (bCand !== null) {
            if (bCand < bApl) {
              bApl = bCand;
              reconfigs += 1;
              ultimaMudanca = t;
            }
            reconstruir(t, bApl, todos);
          } else {
            // nem no piso cabe: o excedente volta para a fila (a porta fecha)
            const orf = todos.filter((c) => c.pai === null);
            for (const o of orf) {
              o.estado = 'espera';
              o.prox = t + 15;
              o.filhos = new Set();
              expulsos += 1;
            }
          }
        }
      }
      // a cada 30 s: se a árvore cabe a um b maior e o ceil limita, reconstrói (no máx. 1 por 120 s)
      if (t % 30 === 0 && t - ultRecon >= 120 && bApl < TETO_1080) {
        const todos = assistindo();
        if (todos.length > 0) {
          const bCand = bComFolga(todos);
          if (bCand !== null && bCand > ceilTeto * 1.1 && bCand > bApl * 1.1) {
            reconstruir(t, Math.min(bCand, bApl * 1.2), todos);
          }
        }
      }
    }

    // 6. métricas
    if (t >= WARM) {
      segsCadeira += N;
      const id = presetParaOrcamento(bApl, 'fluidez');
      bAplHist.push(bApl);
      for (const c of cadeiras) {
        if (c.estado !== 'assiste') continue;
        segsPresentes += 1;
        c.segAssistindo += 1;
        const semImg = c.pai === null || t < c.semFonteAte || c.enviado < 1;
        if (semImg) {
          segsSemImg += 1;
          c.segSemImagem += 1;
          continue;
        }
        const video = Math.max(0, c.enviado - AUDIO);
        const bpp = video / (pixels(id) * 60);
        histBpp.push(bpp);
        histProf.push(c.prof);
        segsViu += 1;
        if (video < PISO_FUNDO) segsAfoga += 1;
        if (video >= PISO_720) seg720 += 1;
        if (bpp < 0.1) segQuad += 1;
      }
    }
  }

  // eventos/hora só de quem estava lá no período medido (aproximação: soma de todos / horas-espectador)
  let eventos = 0;
  let trocas = 0;
  let horasEsp = 0;
  for (const c of cadeiras) {
    eventos += c.eventos;
    trocas += c.trocas;
    horasEsp += c.segAssistindo / 3600;
  }
  return {
    presenca: segsPresentes / segsCadeira,
    espectadoresMedios: segsPresentes / (SEG - WARM),
    bppMed: mediana(histBpp),
    bppP10: pct(histBpp, 0.1),
    mbpsMed: (mediana(histBpp) * pixels(presetParaOrcamento(mediana(bAplHist), 'fluidez')) * 60 + AUDIO) / 1e6,
    degrauMed: presetParaOrcamento(mediana(bAplHist), 'fluidez'),
    bAplMed: mediana(bAplHist) / 1e6,
    afogaPct: (100 * segsAfoga) / Math.max(1, segsViu),
    quadPct: (100 * segQuad) / Math.max(1, segsViu),
    pct720: (100 * seg720) / Math.max(1, segsViu),
    latExtraMed: (mediana(histProf) - 1) * SALTO_MS,
    latExtraP90: (pct(histProf, 0.9) - 1) * SALTO_MS,
    quedasPorHora: horasEsp > 0 ? eventos / horasEsp : 0,
    trocasPorHora: horasEsp > 0 ? trocas / horasEsp : 0,
    semImagemSPorHora: horasEsp > 0 ? (segsSemImg / 3600 / horasEsp) * 3600 : 0,
    reconfigsPorHora: reconfigs / ((SEG - WARM) / 3600),
    hostMbps: somaHost / somaHostAmostras / 1e6,
    expulsos,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   GRADE
   ═══════════════════════════════════════════════════════════════════════ */

function celula(modo, dist, N, U, dmax) {
  const reps = [];
  for (let k = 0; k < REPS; k += 1) {
    reps.push(simular({ modo, dist, N, U, semente: 7000 + N * 131 + U * 7 + k * 100003 + dist.length, dmax }));
  }
  const med = (campo) => mediana(reps.map((x) => x[campo]));
  const out = { modo, dist, N, U };
  for (const campo of Object.keys(reps[0])) {
    out[campo] = campo === 'degrauMed' ? reps[Math.floor(reps.length / 2)][campo] : med(campo);
  }
  return out;
}

const PREMISSAS = `
PREMISSAS DO MODELO (o que ele NÃO prova)
 P1  Rede: fluido, 1 s por passo; AIMD 8 %/s, tampa 1,5 x acked + 10 kbps, recuo 0,85 x enviado, ruído de leitura
     de 20 %, partilha max-min (as mesmas constantes de malhas.sim.mjs). Sem perda, sem fila, sem jitter.
 P2  O governador é uma versão mínima do real (histerese de corte de 30 %, subida de 6 % por decisão, sonda
     com espera 15 -> 240 s, aquecimento de 8 amostras, voto imediato abaixo de 60 %). NÃO é a sessão real:
     o resultado absoluto de qualidade difere do de malhas.sim.mjs; a COMPARAÇÃO malha x cascata usa o mesmo
     governador nos dois lados.
 P3  b é único na sala (R5). O gargalo da sala é o PIOR caminho da árvore (mínimo dos orçamentos das arestas).
 P4  Subida dos espectadores sorteada das três distribuições do estudo 2 §4.3: pesos [A], sem fonte.
     Download dos espectadores nunca limita (as descidas de 1080p60 cabem em qualquer plano de 25+ Mbps).
 P5  Repassador: cede ${CEDE * 100} % da subida ao repasse (orçamento), no máx. ${K_MAX} filhos, só se subida >= ${MIN_RELE} Mbps e
     opt-in (${OPTIN * 100} %). Rajadas de jogo/call: ${f(1 / RAJADA_TAXA, 0)} s entre rajadas por repassador, ${RAJADA_DUR} s a ${RAJADA_FATOR * 100} % da subida.
 P6  Repasse em granularidade de quadro: +${SALTO_MS} ms por salto (estudo 2 §4.6, [I], NÃO medido; E2 mede).
 P7  Churn: permanência exponencial média ${PERMANENCIA / 60} min; a cadeira é ocupada por outra pessoa ~${REENTRADA} s depois.
     Só saídas derrubam subárvores: sem queda de Wi-Fi, sem falha de ICE entre espectadores (ESSA é a hipótese
     que mais pode estar errada: CGNAT entre dois espectadores).
 P8  Religação: ${'0,7–1,2'} s com o host como pai reserva, ${'1,2–2,0'} s com outro repassador, 1 s por aresta movida numa
     reconstrução, 0,5 s por reparentamento antecipado numa rajada. Todos [I], E4 mede.
 P9  Malha: admissão pelo piso (ADR 0030) com a capacidade em regime ( ⌊0,75·U / (1,1·(piso360p60 + áudio))⌋, teto 50 ),
     SEM a janela de 5 até medir e SEM o atraso de 10–25 s da porta: otimista para a malha.
 P10 A cascata admite quem cabe ao piso (b >= piso do 360p60) com a árvore reconstruída, como a porta faz.
 P11 Cadeiras que não entram tentam de novo a cada 15 s para sempre ("presença" mede o tempo com imagem).
 P12 Sem integridade (repassador malicioso), sem assinatura de quadro, sem custo de CPU do repassador no jogo dele.
`;

if (args['premissas'] === true) {
  console.log(PREMISSAS);
  process.exit(0);
}

const t0 = Date.now();
const resultados = [];

for (const dist of Object.keys(DISTRIBUICOES)) {
  for (const N of Ns) {
    for (const U of Us) {
      resultados.push(celula('malha', dist, N, U, DMAX));
      resultados.push(celula('cascata', dist, N, U, DMAX));
    }
  }
}
const dur = (Date.now() - t0) / 1000;

if (args['md'] === true) {
  console.log(
    `| dist | N | host U | malha: entram | malha: b (Mbps) | malha: bpp | cascata: entram | cascata: b (Mbps) | cascata: bpp | ≥720p60 malha → cascata | +latência (mediana / p90 ms) | quedas/h (ancestral saiu) | trocas/h (reparent. antecipado) | s sem imagem/h | host usa (Mbps) |`,
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
}
if (args['md'] !== true) {
  console.log(
    `\nMALHA (ADR 0030) x CASCATA (dmax ${DMAX}) — ${REPS} rep. x ${SEG} s por célula (primeiros ${WARM} s descartados), ${f(dur, 1)} s de relógio`,
  );
  console.log(
    'dist    N  U(host) | MALHA entram   b    bpp  720p% afoga% | CASCATA entram    b    bpp  720p% afoga% | +lat med/p90 | quedas/h trocas/h s s/imagem/h | host usa | reconf/h expulsos',
  );
}
for (let i = 0; i < resultados.length; i += 2) {
  const m = resultados[i];
  const c = resultados[i + 1];
  if (args['md'] === true) {
    console.log(
      `| ${m.dist} | ${m.N} | ${m.U} | ${f(m.espectadoresMedios, 1)} | ${f(m.mbpsMed, 1)} | ${f(m.bppMed, 3)} | ${f(c.espectadoresMedios, 1)} | ${f(c.mbpsMed, 1)} | ${f(c.bppMed, 3)} | ${f(m.pct720, 0)} % → ${f(c.pct720, 0)} % | +${f(c.latExtraMed, 0)} / +${f(c.latExtraP90, 0)} | ${f(c.quedasPorHora, 1)} | ${f(c.trocasPorHora, 1)} | ${f(c.semImagemSPorHora, 1)} | ${f(c.hostMbps, 0)} |`,
    );
  } else {
    console.log(
      `${m.dist.padEnd(7)} ${String(m.N).padStart(2)}  ${String(m.U).padStart(5)}  |  ${f(m.espectadoresMedios, 1).padStart(6)} ${f(m.mbpsMed, 1).padStart(6)} ${f(m.bppMed, 3).padStart(6)} ${f(m.pct720, 0).padStart(5)} ${f(m.afogaPct, 0).padStart(5)}  |  ${f(c.espectadoresMedios, 1).padStart(6)} ${f(c.mbpsMed, 1).padStart(7)} ${f(c.bppMed, 3).padStart(6)} ${f(c.pct720, 0).padStart(5)} ${f(c.afogaPct, 0).padStart(5)}  | +${f(c.latExtraMed, 0).padStart(3)}/+${f(c.latExtraP90, 0).padStart(3)} | ${f(c.quedasPorHora, 2).padStart(6)} ${f(c.trocasPorHora, 1).padStart(7)} ${f(c.semImagemSPorHora, 1).padStart(10)} | ${f(c.hostMbps, 0).padStart(6)} | ${f(c.reconfigsPorHora, 0).padStart(6)} ${f(c.expulsos, 1).padStart(5)}`,
    );
  }
}
if (args['md'] !== true) {
  console.log(PREMISSAS);
  console.log('Colunas: "entram" = espectadores médios com imagem no ar (de N cadeiras); b = Mbps entregues por espectador (mediana no tempo);');
  console.log('bpp = bits por pixel entregue (piso 0,10; teto 0,13); 720p% = % do tempo-espectador a >= 6,2 Mbps; afoga% = abaixo do piso de 360p60 (1,9 Mbps).');
}
writeFileSync(join(RAIZ, 'e2e/cascata.sim.json'), JSON.stringify({ dmax: DMAX, segundos: SEG, reps: REPS, resultados }, null, 1));
