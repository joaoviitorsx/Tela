/**
 * Estudo 2 (transporte) — calculadora, não benchmark. Sem navegador.
 *
 *   node e2e/bench/estudo-transporte.mjs            # as três partes
 *   node e2e/bench/estudo-transporte.mjs --parte=rampa|pacing|perda
 *   node e2e/bench/estudo-transporte.mjs --idr=8    # IDR = 8 x quadro P (padrão 8; Discord publica 6-10x)
 *
 * Complementa `docs/engenharia/estudo/2-transporte-e-topologia.md`. Cada parte
 * é um MODELO com premissas escritas no topo da função; o que o modelo não
 * sabe (feedback real do transport-cc, agendamento real dos pacers do
 * Chromium) está marcado "medir em navegador".
 *
 * A escada vem de `packages/shared` (a real). O resto é aritmética.
 */
import { sobTsx, RAIZ, W, args, fmt } from './comum.mjs';
import { join } from 'node:path';

sobTsx(import.meta.url);

const { PRESETS, pisoDeBitrate, tetoDeBitrate, P2P_LIMITS } = await import(
  join(RAIZ, 'packages/shared/src/encoding.ts')
);
const { presetParaOrcamento } = await import(W('core/media/presets.ts'));

const FOLGA = P2P_LIMITS.uplinkHeadroom; // 0,75
const AUDIO = 141_000;
const PARTE = args['parte'] ?? 'todas';
const IDR_X = Number(args['idr'] ?? 8);
const Ns = [5, 10, 20, 50];
const Us = [10, 50, 100, 300];
const FPS = 60;
const T_QUADRO = 1 / FPS;

/** PRNG determinístico (mulberry32), mesma família do simulador. */
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

/** O que a malha de hoje entrega por espectador (mesma conta de rede-malha-vs-arvore.calc.mjs). */
function malha(U, N) {
  const orc = Math.max(0, FOLGA * U * 1e6 - AUDIO) / N;
  const id = presetParaOrcamento(orc, 'fluidez');
  const p = PRESETS[id];
  const teto = tetoDeBitrate(p.width, p.height, 60);
  const piso = pisoDeBitrate(p.width, p.height, 60);
  return { id, gasto: Math.min(orc, teto), abaixoDoPiso: Math.min(orc, teto) < piso };
}

/* ═══════════════════════════════════════════════════════════════════════
   PARTE 1 — RAMPA DE UM CAMINHO NOVO
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Tempo para a estimativa de um caminho ir de S0 a T (bits/s), em segundos.
 *
 * AIMD (aimd_rate_control.cc, main 2026): multiplicativo 1,08^min(dt,1 s).
 * Sondas (probe_controller.cc): 1ª rodada a 3×S e 6×S (p1/p2), 100 ms de
 * cluster; continua a 2× o resultado enquanto o resultado >= 0,7× o alvo da
 * sonda; tudo limitado a `max_bitrate_` — que SEM x-google-max-bitrate vale
 * kDefaultMaxProbingBitrate = 5 Mbps. Cada rodada custa ~0,2 s + RTT.
 * NADA (RFC 8698 §4.3): gamma = min(0,5, QBOUND/(rtt+DELTA+DFILT)) por
 * feedback de 100 ms. SCReAM v1 (RFC 8298): RAMP_UP_SPEED = 200 kbps/s.
 *
 * `C` é a capacidade do caminho (limita o que a sonda mede).
 */
function tempoAimd(S0, T) {
  return Math.log(T / S0) / Math.log(1.08);
}
function tempoSondas(S0, T, C, tetoSonda, rtt) {
  let est = S0;
  let t = 0;
  let alvos = [3 * S0, 6 * S0];
  for (let r = 0; r < 8 && est < T; r += 1) {
    const efetivos = alvos.map((a) => Math.min(a, tetoSonda));
    const medidos = efetivos.map((a) => Math.min(a, C));
    t += 0.1 + 0.1 + rtt; // cluster + feedback do transport-cc + RTT
    const melhor = Math.max(est, ...medidos);
    const maxAlvo = Math.max(...efetivos);
    const continua = melhor >= 0.7 * maxAlvo && maxAlvo < tetoSonda && melhor < C;
    est = melhor;
    if (!continua) break;
    alvos = [2 * melhor];
  }
  return { t, est };
}
function tempoNada(S0, T, rtt) {
  const gamma = Math.min(0.5, 0.05 / (rtt + 0.1 + 0.12));
  return (Math.log(T / S0) / Math.log(1 + gamma)) * 0.1;
}

if (PARTE === 'todas' || PARTE === 'rampa') {
  console.log('\n═══ PARTE 1 — tempo de rampa de um caminho novo, de S0 até T (s) ═══');
  console.log('S0 = início (x-google-start-bitrate); T = alvo; RTT 40 ms; capacidade do caminho C = 2×T.');
  console.log('AIMD = só 1,08/s | sondas(5M) = sondas com teto padrão de 5 Mbps e depois AIMD | sondas(livre) = com x-google-max-bitrate >= T | NADA | SCReAMv1');
  console.log('S0 (Mbps)  T (Mbps)   AIMD    sondas(5M)  sondas(livre)   NADA   SCReAMv1');
  const rtt = 0.04;
  for (const S0 of [0.3, 1.9, 6, 12]) {
    for (const T of [6, 12, 16.2]) {
      if (S0 >= T) continue;
      const s0 = S0 * 1e6;
      const t = T * 1e6;
      const aimd = tempoAimd(s0, t);
      const a = tempoSondas(s0, t, 2 * t, 5e6, rtt);
      const tAte5 = a.t + (a.est < t ? tempoAimd(a.est, t) : 0);
      const b = tempoSondas(s0, t, 2 * t, 1e9, rtt);
      const tLivre = b.t + (b.est < t ? tempoAimd(b.est, t) : 0);
      console.log(
        `${fmt(S0, 1).padStart(8)}  ${fmt(T, 1).padStart(8)}  ${fmt(aimd, 1).padStart(6)}  ${fmt(tAte5, 1).padStart(10)}  ${fmt(tLivre, 1).padStart(13)}  ${fmt(tempoNada(s0, t, rtt), 1).padStart(6)}  ${fmt((t - s0) / 200_000, 0).padStart(8)}`,
      );
    }
  }
  console.log('\nCUSTO DA SONDA DE ENTRADA NUM LINK COMPARTILHADO (o recém-chegado sonda a 3×S e 6×S durante 100 ms cada):');
  console.log('N+1 chegando em upload U; S0 = orçamento atual por caminho; sem teto de sonda (x-google-max-bitrate alto).');
  console.log('U (Mbps)  N    S0 (Mbps)  carga que a sonda soma (Mbps)   atraso de fila por 200 ms de sonda (ms)');
  for (const U of Us) {
    for (const N of [10, 20, 50]) {
      const m = malha(U, N);
      const s = m.gasto;
      const extra = 6 * s; // pico: o cluster de 6×S roda sobre os N caminhos já em carga ~0,75U
      const carga = (N * s) / 1e6;
      const sobra = U - carga; // folga do link além do tráfego atual
      const excesso = Math.max(0, extra / 1e6 - sobra); // Mbps que não cabem durante o cluster
      const filaMs = ((excesso * 1e6 * 0.1) / (U * 1e6)) * 1000; // 100 ms de excesso / capacidade
      console.log(
        `${String(U).padStart(7)}  ${String(N).padStart(2)}  ${fmt(s / 1e6, 2).padStart(9)}  ${fmt(extra / 1e6, 1).padStart(28)}   ${fmt(filaMs, 1).padStart(14)}`,
      );
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   PARTE 2 — PACING: N SENDERS ALINHADOS NO MESMO UPLINK
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Modelo fluido do gargalo do upload do transmissor.
 *
 * Cada sender i recebe o quadro (S bytes) no instante o_i. O pacer do
 * libwebrtc (pacing_controller.cc/.h, main 2026) deixa sair, de uma vez, até
 * `B0 = min(63 KB, 40 ms × R, S)` ("send_burst_interval" 40 ms,
 * `kMaxBurstSize` 63 KB) e o resto a R = pacing_factor × estimativa. O fator
 * vale 1,1 com feedback send-side (goog_cc_network_control.cc,
 * kDefaultPaceMultiplierWithSendSideBwe).
 *
 * PREMISSA NÃO VERIFICADA: que os N pacers (um por RTCPeerConnection/Call)
 * disparem no mesmo milissegundo. O quadro entra em todos pela mesma tarefa
 * do worker de injeção, então é o caso provável; a medição real é em
 * navegador (bytesSent por RTCPeerConnection a cada 1 ms não existe — usar
 * captura de pacotes no gargalo, `tc qdisc ... netem rate` + `tcpdump`).
 */
function filaMax(N, U, S, R, offsets) {
  const B0 = Math.min(63_000, (0.04 * R) / 8, S);
  const dt = 5e-5;
  const fim = 0.4;
  const capBytes = (U * 1e6) / 8; // bytes/s
  let q = 0;
  let max = 0;
  const emitido = new Float64Array(N);
  for (let t = 0; t < fim; t += dt) {
    let chegou = 0;
    for (let i = 0; i < N; i += 1) {
      const dti = t - offsets[i];
      let alvo = 0;
      if (dti >= 0) alvo = Math.min(S, B0 + (R / 8) * dti);
      chegou += alvo - emitido[i];
      emitido[i] = alvo;
    }
    q = Math.max(0, q + chegou - capBytes * dt);
    if (q > max) max = q;
  }
  return (max / capBytes) * 1000; // ms
}

if (PARTE === 'todas' || PARTE === 'pacing') {
  console.log(`\n═══ PARTE 2 — fila no gargalo do upload do transmissor (ms), IDR = ${IDR_X} × quadro P ═══`);
  console.log('R = ritmo do pacer = fator × b. fator 1,1 = estimativa colada no envio; 1,65 = estimativa em 1,5× o enviado (tampa do AIMD).');
  console.log('"alin" = os N senders no mesmo instante; "esc4" = escalonados em janela de 4 ms; "esc17" = em todo o intervalo do quadro (16,7 ms; custo: até 16,7 ms a mais no último sender).');
  console.log('U    N   degrau      b(Mbps) P(KB) IDR(KB) | fator | P alin  P esc4  P esc17 | IDR alin  IDR esc(janela=S/R)  | tempo de IDR por sender (ms)');
  for (const U of Us) {
    for (const N of Ns) {
      const m = malha(U, N);
      const b = m.gasto;
      const P = b / FPS / 8;
      const IDR = P * IDR_X;
      for (const fator of [1.1, 1.65]) {
        const R = fator * b;
        const off = (w) => Array.from({ length: N }, (_, i) => (i * w) / N);
        const fP0 = filaMax(N, U, P, R, off(0));
        const fP4 = filaMax(N, U, P, R, off(0.004));
        const fP17 = filaMax(N, U, P, R, off(T_QUADRO));
        const tIdr = ((IDR * 8) / R) * 1000;
        const fI0 = filaMax(N, U, IDR, R, off(0));
        const fIe = filaMax(N, U, IDR, R, off(IDR * 8 / R));
        console.log(
          `${String(U).padStart(3)} ${String(N).padStart(3)}  ${m.id.padEnd(9)}${m.abaixoDoPiso ? '*' : ' '} ${fmt(b / 1e6, 2).padStart(6)} ${fmt(P / 1000, 1).padStart(5)} ${fmt(IDR / 1000, 0).padStart(6)}  | ${fmt(fator, 2)} | ${fmt(fP0, 1).padStart(6)} ${fmt(fP4, 1).padStart(6)} ${fmt(fP17, 1).padStart(7)} | ${fmt(fI0, 1).padStart(7)} ${fmt(fIe, 1).padStart(14)}      | ${fmt(tIdr, 0).padStart(6)}`,
        );
      }
    }
  }
  console.log('\n  * = orçamento abaixo do piso do degrau (célula em que a malha já afoga; ver ADR 0030).');
  console.log('  Leitura: com b no orçamento (N·b ≈ 0,75·U) o pico alinhado converge para ~0,75·40 ms·fator ≈ 33–50 ms quando o burst é limitado pela janela de 40 ms,');
  console.log('  e para N·63 KB/U quando o teto de 63 KB manda. O tempo de IDR por sender (S_idr/R) independe de U e de N: é ~IDR_X/60/fator segundos.');
}

/* ═══════════════════════════════════════════════════════════════════════
   PARTE 3 — PERDA: NACK/RTX x FEC (Monte Carlo por quadro)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Premissas (todas escritas porque o modelo é teórico):
 *  - Pacote de 1200 B de payload; K = ceil(S/1200).
 *  - Perda iid (Bernoulli p) ou em rajada (Gilbert-Elliott, perda 100 % no
 *    estado ruim, rajada média 3 pacotes, perda média p).
 *  - Detecção do buraco = chegada do pacote seguinte (≈ 1 espaçamento do
 *    pacer); cauda do quadro espera o primeiro pacote do quadro seguinte.
 *  - NACK reenvia a cada RTT + 10 ms (nack_requester.cc: pacote reenviado
 *    quando passou >= rtt desde o último pedido; tick de 20 ms; até 100
 *    tentativas). NACK e RTX perdem-se com a mesma p (independentes, otimista
 *    para rajada).
 *  - "Soluço" visível = o quadro completa mais de J ms depois do instante
 *    nominal. J = o jitter buffer do espectador (60 ms inicial, 40–240 ms
 *    pelo JitterGovernor). Um quadro atrasado trava os seguintes (P→P).
 *  - FEC = código MDS ideal sobre os pacotes do QUADRO, m = ceil(r·K)
 *    (cota SUPERIOR de ganho: ULPFEC real é pior, FlexFEC 2D também).
 *    Se perdidos > m, recai-se no NACK de TODOS os perdidos (conservador).
 *  - libwebrtc desliga ULPFEC para H.264 quando NACK está ligado
 *    (rtp_video_sender.cc, PayloadTypeSupportsSkippingFecPackets: só VP8/VP9);
 *    este modelo mostra o que FlexFEC (field trial) compraria.
 */
function tentaQuadro(r, K, p, rtt, J, ritmoMs, fecR, bursty, hops) {
  const m = fecR > 0 ? Math.ceil(fecR * K) : 0;
  let excessoTotal = 0;
  for (let h = 0; h < hops; h += 1) {
    // sequência de perdas dos K+m pacotes
    const n = K + m;
    const perdido = new Array(n).fill(false);
    if (bursty) {
      const B = 3;
      const pBG = 1 / B;
      const pGB = p / ((1 - p) * B);
      let ruim = r() < p;
      for (let i = 0; i < n; i += 1) {
        perdido[i] = ruim;
        ruim = ruim ? r() >= pBG : r() < pGB;
      }
    } else {
      for (let i = 0; i < n; i += 1) perdido[i] = r() < p;
    }
    let L = 0;
    for (let i = 0; i < n; i += 1) if (perdido[i]) L += 1;
    const perdidosMidia = perdido.slice(0, K).filter(Boolean).length;
    if (perdidosMidia === 0) continue;
    if (m > 0 && L <= m) {
      excessoTotal += (m * ritmoMs) / 1; // espera os pacotes de FEC: m espaçamentos
      continue;
    }
    // NACK: tempo de recuperação do pior pacote perdido
    let pior = 0;
    for (let i = 0; i < K; i += 1) {
      if (!perdido[i]) continue;
      const cauda = i === K - 1 ? 6 : 0;
      let t = ritmoMs + cauda; // detecção
      let ok = false;
      for (let rodada = 0; rodada < 100 && !ok; rodada += 1) {
        t += rtt + (rodada === 0 ? 2 : 10);
        ok = r() >= p && r() >= p;
      }
      // excesso em relação ao instante em que o pacote chegaria sem perda
      const excesso = t - (K - 1 - i) * ritmoMs; // atraso em relação à chegada nominal do ÚLTIMO pacote do quadro
      if (excesso > pior) pior = excesso;
    }
    excessoTotal += pior;
  }
  return excessoTotal > J;
}

function celula(K, p, rtt, J, fecR, bursty, hops, quadros, semente) {
  const r = rng(semente);
  let soluco = 0;
  for (let q = 0; q < quadros; q += 1) {
    if (tentaQuadro(r, K, p, rtt, J, 0.8, fecR, bursty, hops)) soluco += 1;
  }
  return soluco / quadros;
}

if (PARTE === 'todas' || PARTE === 'perda') {
  console.log('\n═══ PARTE 3 — perda: soluço visível (quadro completa > J ms tarde) ═══');
  console.log('1080p60 no piso: P ≈ 26 KB (K=22 pacotes), IDR ≈ 8× (K=173). Espaçamento do pacer ≈ 0,8 ms. J = 60 ms.');
  const J = 60;
  const estrategias = [
    ['NACK', 0],
    ['NACK+FEC10%', 0.1],
    ['NACK+FEC25%', 0.25],
  ];
  for (const bursty of [false, true]) {
    console.log(`\n  perda ${bursty ? 'EM RAJADA (GE, rajada média 3)' : 'iid'} — quadro P; soluços/minuto a 60 fps (1 salto)  [extra de banda entre colchetes]`);
    console.log('  RTT   p      ' + estrategias.map(([n]) => n.padEnd(22)).join(''));
    for (const rtt of [20, 40, 80]) {
      for (const p of [0.005, 0.01, 0.02, 0.05]) {
        const cols = estrategias.map(([, fec], k) => {
          const pr = celula(22, p, rtt, J, fec, bursty, 1, 40000, 7 + k);
          const banda = fec > 0 ? fec * 100 + p * 100 * 0.3 : p * 100; // FEC: r; NACK: ≈ p (retx)
          return `${fmt(pr * 3600, 1).padStart(7)} [+${fmt(banda, 1)}%]`.padEnd(22);
        });
        console.log(`  ${String(rtt).padStart(3)}  ${fmt(p * 100, 1).padStart(4)}%  ${cols.join('')}`);
      }
    }
  }
  console.log('\n  Quanto buffer compra o mesmo que o FEC? NACK puro, iid, soluços/min, quadro P (1 salto) — J varia, RTT e p fixos');
  console.log('  RTT   p      J=60      J=80      J=100     J=130     J=160   (FEC10% com J=60 para comparar)');
  for (const rtt of [40, 80]) {
    for (const p of [0.01, 0.02]) {
      const cols = [60, 80, 100, 130, 160].map((j) => fmt(celula(22, p, rtt, j, 0, false, 1, 40000, 55) * 3600, 1).padStart(8));
      const fec = fmt(celula(22, p, rtt, 60, 0.1, false, 1, 40000, 56) * 3600, 1).padStart(8);
      console.log(`  ${String(rtt).padStart(3)}  ${fmt(p * 100, 1).padStart(4)}%  ${cols.join('  ')}   ${fec}`);
    }
  }
  console.log('\n  Acúmulo por salto (NACK, iid, RTT 40 ms por salto — a atraso de cada salto soma): soluços/min');
  console.log('  p      d=1       d=2       d=3');
  for (const p of [0.005, 0.01, 0.02, 0.05]) {
    const cols = [1, 2, 3].map((d) => fmt(celula(22, p, 40, J, 0, false, d, 40000, 21) * 3600, 1).padStart(8));
    console.log(`  ${fmt(p * 100, 1).padStart(4)}%  ${cols.join('  ')}`);
  }
  console.log('\n  Que J esconde a perda com d saltos? NACK, iid, RTT 40 ms por salto, p = 1 %: soluços/min');
  console.log('  d    J=60     J=100    J=140    J=180    J=220');
  for (const d of [1, 2, 3]) {
    const cols = [60, 100, 140, 180, 220].map((j) => fmt(celula(22, 0.01, 40, j, 0, false, d, 40000, 77) * 3600, 1).padStart(7));
    console.log(`  ${d}  ${cols.join('  ')}`);
  }
  console.log('\n  Quadro-chave (K=173) — probabilidade de soluço por IDR, NACK, iid, RTT 40/80 ms:');
  console.log('  p      RTT40     RTT80     (um IDR por entrada de espectador, mais os PLIs)');
  for (const p of [0.005, 0.01, 0.02, 0.05]) {
    const a = celula(173, p, 40, J, 0, false, 1, 4000, 33);
    const b = celula(173, p, 80, J, 0, false, 1, 4000, 34);
    console.log(`  ${fmt(p * 100, 1).padStart(4)}%  ${fmt(a * 100, 1).padStart(6)}%   ${fmt(b * 100, 1).padStart(6)}%`);
  }
}
