/**
 * SIMULADOR DAS MALHAS DE CONTROLE DE QUALIDADE.
 *
 * Não é teste de unidade e não é browser. É um banco de ensaio: monta a malha
 * REAL — `BroadcastSession` + `UplinkGovernor` + `MeshTopology` + `StatsSampler`
 * + a escada de `@tela/shared` — contra um modelo de rede que imita o que o
 * libwebrtc de fato faz, e roda 300 segundos simulados por cenário.
 *
 * Nada aqui é reimplementação da lógica do produto. O único código novo é a
 * REDE: capacidade, fila, estimador AIMD, ruído e queda. Toda decisão de
 * qualidade sai das classes de `apps/` e `packages/`.
 *
 *   node e2e/malhas.sim.mjs                # matriz completa (1200 cenários, ~5s)
 *   node e2e/malhas.sim.mjs --rapido       # subconjunto, para iterar
 *   node e2e/malhas.sim.mjs --escala       # sala grande (10, 20, 50), portão próprio
 *   node e2e/malhas.sim.mjs --quedas       # só a sub-matriz de queda sustentada
 *   node e2e/malhas.sim.mjs --trace=<id>   # série temporal de um cenário
 *   node e2e/malhas.sim.mjs --premissas    # só o texto das premissas do modelo
 *   node e2e/malhas.sim.mjs --clamp-duro   # leitura estrita do ClampBitrate
 *   node e2e/malhas.sim.mjs --cpu-cobra    # CPU também come bitrate entregue
 *   node e2e/malhas.sim.mjs --pessimista   # as duas acima juntas
 *
 * As premissas do modelo estão em `PREMISSAS`, no fim do arquivo, e saem no
 * rodapé de todo relatório. Um simulador que sempre passa não prova nada: onde
 * o modelo é otimista está escrito lá, e as flags medem quanto disso importa.
 *
 * O resumo por cenário sai em `e2e/malhas.sim.json` — artefato de execução,
 * não fonte. Não pertence ao repositório.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ═══════════════════════════════════════════════════════════════════════
   0. BOOTSTRAP — carregar TypeScript real sem passo de build do web
   ═══════════════════════════════════════════════════════════════════════ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..');

function acharTsx() {
  const diretos = [
    join(RAIZ, 'node_modules/tsx/dist/esm/index.mjs'),
    join(RAIZ, 'apps/web/node_modules/tsx/dist/esm/index.mjs'),
  ];
  for (const p of diretos) if (existsSync(p)) return p;

  const store = join(RAIZ, 'node_modules/.pnpm');
  if (!existsSync(store)) return null;
  const candidatos = readdirSync(store)
    .filter((nome) => nome.startsWith('tsx@'))
    .sort()
    .reverse();
  for (const nome of candidatos) {
    const p = join(store, nome, 'node_modules/tsx/dist/esm/index.mjs');
    if (existsSync(p)) return p;
  }
  return null;
}

if (process.env['SIM_SOB_TSX'] !== '1') {
  const loader = acharTsx();
  if (loader === null) {
    console.error(
      'Não achei o loader do tsx. Rode `pnpm install` na raiz, ou\n' +
        '`pnpm --filter @tela/shared build && npx tsx e2e/malhas.sim.mjs`.',
    );
    process.exit(2);
  }
  // `@tela/shared` é resolvido pelo `main` do pacote, que aponta para `dist/`.
  const build = spawnSync('pnpm', ['--filter', '@tela/shared', 'build'], {
    cwd: RAIZ,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    console.error('Falhou o build de @tela/shared.');
    process.exit(build.status ?? 1);
  }
  const filho = spawnSync(
    process.execPath,
    ['--import', loader, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { cwd: RAIZ, stdio: 'inherit', env: { ...process.env, SIM_SOB_TSX: '1' } },
  );
  process.exit(filho.status ?? 1);
}

/* ═══════════════════════════════════════════════════════════════════════
   1. AS CLASSES REAIS DO PRODUTO
   ═══════════════════════════════════════════════════════════════════════ */

const W = (p) => join(RAIZ, 'apps/web/src', p);

const { BroadcastSession } = await import(W('core/media/broadcast-session.ts'));
const { MeshTopology } = await import(W('core/mesh/mesh-topology.ts'));
const { StatsSampler } = await import(W('core/media/stats-sampler.ts'));
const { UplinkGovernor, UPLINK_SHARE } = await import(W('core/media/uplink-governor.ts'));
const { POLL_MIN_MS, POLL_MAX_MS, POLL_FACTOR } = await import(W('core/media/viewer-session.ts'));
const { pisoPorEspectador } = await import(W('core/media/capacidade-pela-banda.ts'));
const presetsMod = await import(W('core/media/presets.ts'));
const { PRESETS, PRESET_IDS, presetById, presetParaOrcamento } = presetsMod;
const { BPP_PISO, BPP_TETO, tetoDeBitrate } = await import(
  join(RAIZ, 'packages/shared/src/encoding.ts'),
);
const fakes = await import(W('core/testing/fakes.ts'));
const meshTesting = await import(W('core/mesh/testing.ts'));

const {
  FakeAudioCapture,
  FakeAudioGain,
  FakeScheduler,
  FakeScreenCapture,
  fakeStream,
  createStream,
  shareUrlFor,
} = fakes;
const { fakeConnectionFactory, statsReport } = meshTesting;

// Sanidade: se qualquer um destes vier `undefined`, todo o resto é teatro.
for (const [nome, valor] of Object.entries({
  BroadcastSession,
  MeshTopology,
  StatsSampler,
  UplinkGovernor,
  presetParaOrcamento,
  UPLINK_SHARE,
  BPP_PISO,
  BPP_TETO,
  tetoDeBitrate,
  POLL_MIN_MS,
  pisoPorEspectador,
})) {
  if (valor === undefined) throw new Error(`import real quebrado: ${nome}`);
}

/* ═══════════════════════════════════════════════════════════════════════
   2. UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

const ARGS = process.argv.slice(2);
const flag = (nome) => ARGS.includes(`--${nome}`);
const opcao = (nome) => {
  const hit = ARGS.find((a) => a.startsWith(`--${nome}=`));
  return hit === undefined ? null : hit.slice(nome.length + 3);
};

/**
 * Duas premissas do modelo viram botão, porque cada uma muda o resultado.
 *
 * `--clamp-duro`  o ruído da amostra é reclampado em `1,5 × acked + 10 kbps`.
 *                 Leitura ESTRITA do libwebrtc: `ClampBitrate` é um clamp duro
 *                 dentro de `ChangeBitrate`. Corta a metade de cima do ruído e
 *                 puxa a média da estimativa para 1,425 × acked em vez de 1,5.
 * `--cpu-cobra`   pressão de CPU custa 10% do que o encoder entrega, o que
 *                 deprime `acked` e, por tabela, o teto do estimador.
 * `--pessimista`  as duas juntas.
 *
 * O PADRÃO é o enunciado do problema: ±20% de oscilação por amostra sobre a
 * estimativa, sem reclamp. É a premissa mais generosa com o produto, e é de
 * propósito — o que quebrar aqui quebra em qualquer leitura.
 */
const CLAMP_DURO = flag('clamp-duro') || flag('pessimista');
const CPU_COBRA = flag('cpu-cobra') || flag('pessimista');
const RAPIDO = flag('rapido');
/**
 * `--escala`: a sala grande da ADR 0029 (10, 20 e 50 espectadores) no lugar
 * da matriz de sempre. Matriz própria e portão próprio — ver `portaoEscala`.
 */
const ESCALA = flag('escala');
/** Teto que o transmissor declara: o do "um encode" (ADR 0029). */
const CAPACIDADE = 50;
const SO_QUEDAS = flag('quedas');
const TRACE = opcao('trace');

const Mbps = (n) => n * 1_000_000;
const emMbps = (bps) => (bps === null || bps === undefined ? '—' : (bps / 1e6).toFixed(2));

/** PRNG determinístico: a matriz inteira precisa reproduzir. */
function mulberry32(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deixa TODA a fila de microtarefas drenar. Mais forte que `await Promise.resolve()`. */
const assentar = async (voltas = 3) => {
  for (let i = 0; i < voltas; i += 1) await new Promise((r) => setImmediate(r));
};

/**
 * Partilha max-min de uma capacidade entre demandas.
 *
 * É o modelo padrão de N fluxos igualmente agressivos num gargalo comum: quem
 * pede menos que a fatia igual leva tudo o que pediu, e a sobra é redividida.
 */
function partilhaMaxMin(capacidade, demandas) {
  const saida = new Array(demandas.length).fill(0);
  let resto = capacidade;
  let abertos = demandas.map((_, i) => i);
  while (abertos.length > 0) {
    const fatia = resto / abertos.length;
    const satisfeitos = abertos.filter((i) => demandas[i] <= fatia);
    if (satisfeitos.length === 0) {
      for (const i of abertos) saida[i] = fatia;
      break;
    }
    for (const i of satisfeitos) {
      saida[i] = demandas[i];
      resto -= demandas[i];
    }
    abertos = abertos.filter((i) => demandas[i] > fatia);
  }
  return saida;
}

/* ═══════════════════════════════════════════════════════════════════════
   3. O MODELO DE REDE

   Quatro coisas, e a primeira é a que causou o defeito da ADR 0018:

   1. TETO DO ESTIMADOR. `AimdRateControl::ClampBitrate` limita a estimativa a
      `1,5 × acked_throughput + 10 kbps`. E `acked ≈ min(capacidade_do_caminho,
      maxBitrate_que_aplicamos, demanda_do_encoder)`. A grandeza MEDIDA é
      limitada pela grandeza ATUADA — malha fechada de verdade.
   2. CAPACIDADE REAL, que o BWE persegue e nunca conhece.
   3. RUÍDO: ±20% por amostra sobre a estimativa reportada.
   4. QUEDA: janelas de capacidade reduzida.

   N espectadores dividem o mesmo uplink (partilha max-min) e cada um tem a
   PRÓPRIA capacidade de descida.
   ═══════════════════════════════════════════════════════════════════════ */

const AIMD_TETO_FATOR = 1.5;
const AIMD_TETO_OFFSET = 10_000;
/** `AimdRateControl::kDefaultBackoffFactor`. */
const AIMD_BETA = 0.85;
/** Subida multiplicativa por segundo quando não há sobreuso. */
const AIMD_SUBIDA = 0.08;
/** Piso do controle de congestionamento do WebRTC. */
const BWE_PISO = 30_000;
const RUIDO = 0.20;
/** Quanto o alvo pode passar da capacidade antes do detector de atraso acusar. */
const MARGEM_SOBREUSO = 1.02;

class Rede {
  constructor(cfg, rng) {
    this.cfg = cfg;
    this.rng = rng;
    this.upBase = cfg.upBps;
    this.peers = cfg.peers.map((p) => ({
      id: p.id,
      downBps: p.downBps,
      entraEm: p.entraEm,
      /**
       * A porta pela banda (ADR 0030): o espectador pede para entrar em
       * `entraEm`; sem vaga recebe CHANNEL_FULL e tenta de novo com o backoff
       * do `ViewerSession` real. `conectaEm` só existe depois de admitido.
       */
      proximaTentativa: p.entraEm,
      pollMs: POLL_MIN_MS,
      recusas: 0,
      admitidoEm: null,
      conectaEm: null,
      conectado: false,
      bwe: 0,
      acked: null,
      bytes: 0,
      sobreuso: false,
      rtt: 0.02,
    }));
  }

  /** Capacidade de subida no instante `t`, com as quedas sustentadas aplicadas. */
  upEm(t) {
    let cap = this.upBase;
    for (const q of this.cfg.quedas ?? []) {
      if (t >= q.de && t < q.ate) cap = this.upBase * q.fator;
    }
    return cap;
  }

  conectar(peer, startBitrateBps) {
    peer.conectado = true;
    // `x-google-start-bitrate` — vem de `MeshTopology.bitrateInicial()`, real.
    peer.bwe = Math.max(BWE_PISO, startBitrateBps ?? 300_000);
    peer.acked = null;
  }

  /**
   * Um segundo de rede, dado o `maxBitrate` que os senders receberam.
   * Devolve nada; muda o estado dos peers, que vira `RTCStatsReport` depois.
   */
  tique(t, dt, maxBitrateAplicado, cpuAtiva) {
    const ativos = this.peers.filter((p) => p.conectado);
    if (ativos.length === 0) return;

    const up = this.upEm(t);
    // Alocador do WebRTC: o encoder recebe `min(BWE, maxBitrate)`.
    const demandas = ativos.map((p) => Math.min(p.bwe, maxBitrateAplicado));
    // A descida do espectador limita antes de o uplink ser disputado.
    const demandasUteis = demandas.map((d, i) => Math.min(d, ativos[i].downBps));
    const fatias = partilhaMaxMin(up, demandasUteis);

    ativos.forEach((p, i) => {
      const demanda = demandas[i];
      const carregado = Math.min(fatias[i], p.downBps);
      let enviado = Math.min(demanda, carregado);

      /**
       * Premissa OTIMISTA (ver `PREMISSAS` P4): sob pressão de CPU o encoder
       * continua entregando o alvo, porque `maintain-framerate` derruba
       * resolução em vez de bits. `--cpu-cobra` cobra 10%, que deprime o
       * `acked` e, com ele, o teto do estimador.
       */
      if (CPU_COBRA && cpuAtiva) enviado *= 0.9;

      p.sobreuso = demanda > carregado * MARGEM_SOBREUSO;
      // Quanto o alvo passou da capacidade — é isto que enche a fila do
      // roteador e faz o ping do jogo subir, que é a promessa do produto.
      p.sobrecarga = carregado > 0 ? demanda / carregado : 1;
      p.acked = enviado;
      p.bytes += (enviado * dt) / 8;
      p.rtt = p.sobreuso ? 0.02 + 0.13 : 0.02 + 0.005 * this.rng();

      if (p.sobreuso) {
        p.bwe = AIMD_BETA * enviado;
      } else {
        p.bwe = p.bwe * (1 + AIMD_SUBIDA) + 1_000;
      }

      // O TETO. É esta linha que faz a medição depender da atuação.
      const teto = AIMD_TETO_FATOR * enviado + AIMD_TETO_OFFSET;
      p.bwe = Math.max(BWE_PISO, Math.min(p.bwe, teto));
    });
  }

  /** O que `getStats()` reporta neste instante, com ruído. */
  reportado(peer) {
    const ruido = 1 + (this.rng() * 2 - 1) * RUIDO;
    const bruto = peer.bwe * ruido;
    if (peer.acked === null || !CLAMP_DURO) return Math.max(BWE_PISO, bruto);
    // Leitura estrita do `ClampBitrate` — ver o bloco de flags no topo.
    const teto = AIMD_TETO_FATOR * peer.acked + AIMD_TETO_OFFSET;
    return Math.max(BWE_PISO, Math.min(bruto, teto));
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   4. O TRANSPORTE DE SIMULAÇÃO

   Implementa a porta `MediaTransport` delegando TUDO que é decisão para uma
   `MeshTopology` real (com `FakePeerConnection`) e para um `StatsSampler`
   real. O que ele acrescenta é só o `getStats()` sintético dos peers.
   ═══════════════════════════════════════════════════════════════════════ */

class SimTransport {
  constructor(rede, cfg) {
    this.rede = rede;
    this.cfg = cfg;
    this.fabrica = fakeConnectionFactory();
    this.amostrador = new StatsSampler('outbound');
    this.ouvintes = new Map();
    this.stream = null;
    this.orcamentos = [];
    this.presetsAplicados = [];
    this.pcPorPeer = new Map();
    this.t = 0;
    this.cpuAtiva = false;
    /** O teto que a sessão mandou ao servidor (ADR 0030), e o histórico dele. */
    this.teto = CAPACIDADE;
    this.capacidades = [];

    this.topology = new MeshTopology({
      iceServers: [{ urls: ['stun:sim'] }],
      send: () => undefined,
      createConnection: this.fabrica.create,
      maxPeers: CAPACIDADE,
    });
  }

  /* ── porta MediaTransport ── */

  async host() {
    return { maxPeers: CAPACIDADE };
  }
  async watch() {}

  async publishVideo(track, preset) {
    this.videoTrack = track;
    this.stream = fakeStream([track]);
    await this.topology.publish(this.stream, [track], preset);
  }
  async publishAudio() {}
  async setPreset(preset) {
    this.presetsAplicados.push(preset.id);
    await this.topology.setPreset(preset);
  }
  async replaceVideo() {}
  async setPrioridade(p) {
    await this.topology.setPrioridade(p);
  }

  async setUplinkBudget(bps) {
    this.orcamentos.push(bps);
    await this.topology.setOrcamento(bps);
  }

  async getAggregateStats() {
    const reports = await this.topology.collectStats();
    if (reports.length === 0) return null;
    return this.amostrador.readMany(reports);
  }

  peers() {
    return this.listaPeers();
  }

  /** O que o servidor receberia: a porta fecha para quem ainda vai entrar. */
  atualizarCapacidade(valor) {
    this.teto = valor;
    this.capacidades.push({ t: this.t, valor });
  }

  temVaga() {
    return this.pcPorPeer.size < this.teto;
  }

  on(evento, handler) {
    const set = this.ouvintes.get(evento) ?? new Set();
    set.add(handler);
    this.ouvintes.set(evento, set);
    return () => set.delete(handler);
  }

  async disconnect() {
    this.topology.close();
  }

  /* ── só na simulação ── */

  emitir(evento, payload) {
    for (const h of this.ouvintes.get(evento) ?? []) h(payload);
  }

  listaPeers() {
    return this.rede.peers
      .filter((p) => this.pcPorPeer.has(p.id))
      .map((p) => ({
        id: p.id,
        connectionState: p.conectado ? 'connected' : 'connecting',
        usingRelay: false,
      }));
  }

  admitir(peer) {
    const antes = this.fabrica.created.length;
    this.topology.admit(peer.id);
    const pc = this.fabrica.created[antes];
    if (pc !== undefined) {
      this.pcPorPeer.set(peer.id, pc);
      pc.emitState('connecting');
    }
    this.emitir('peers', this.listaPeers());
  }

  /** CHANNEL_FULL: o mesmo backoff do `ViewerSession` (advanceBackoff + scheduleRetry). */
  recusar(peer, t) {
    peer.recusas += 1;
    peer.pollMs = Math.min(Math.round(peer.pollMs * POLL_FACTOR), POLL_MAX_MS);
    peer.proximaTentativa = t + peer.pollMs / 1000;
    peer.pollMs = Math.min(Math.round(peer.pollMs * POLL_FACTOR), POLL_MAX_MS);
  }

  conectar(peer) {
    this.rede.conectar(peer, this.topology.bitrateInicial());
    this.pcPorPeer.get(peer.id)?.emitState('connected');
    this.emitir('peers', this.listaPeers());
  }

  /** O `maxBitrate` que de fato chegou ao sender — lido do FakeSender. */
  maxBitrateNoSender() {
    for (const pc of this.fabrica.created) {
      for (const sender of pc.senders) {
        const ultimo = sender.applied.at(-1);
        const enc = ultimo?.encodings?.[0];
        if (enc?.maxBitrate !== undefined) return enc;
      }
    }
    return null;
  }

  /** Reescreve o `getStats()` de cada FakePeerConnection para o instante `t`. */
  prepararStats(t, limitacaoPorPeer) {
    const enc = this.maxBitrateNoSender();
    const escala = enc?.scaleResolutionDownBy ?? 1;
    const largura = Math.round(1920 / escala);
    const altura = Math.round(1080 / escala);
    const fps = enc?.maxFramerate ?? 60;

    for (const peer of this.rede.peers) {
      const pc = this.pcPorPeer.get(peer.id);
      if (pc === undefined) continue;
      if (!peer.conectado) {
        // Conectando: sem par ICE nominado, não contribui para `paresMedidos`.
        pc.getStats = async () => statsReport([]);
        continue;
      }
      const entradas = [
        {
          id: `out-${peer.id}`,
          type: 'outbound-rtp',
          kind: 'video',
          ssrc: 1000 + Number(peer.id.slice(2)),
          bytesSent: Math.round(peer.bytes),
          timestamp: t * 1000,
          framesPerSecond: fps,
          frameWidth: largura,
          frameHeight: altura,
          qualityLimitationReason: limitacaoPorPeer(peer),
          encoderImplementation: 'ExternalEncoder',
        },
        {
          id: `pair-${peer.id}`,
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: peer.rtt,
          availableOutgoingBitrate: Math.round(this.rede.reportado(peer)),
        },
      ];
      pc.getStats = async () => statsReport(entradas);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   5. UM CENÁRIO
   ═══════════════════════════════════════════════════════════════════════ */

const DURACAO_S = 300;
const ICE_MS = 2_000;

/** Teto útil de bits por pixel — a mesma conta privada de `MeshTopology`. */
function tetoUtil(presetId, fps = 60) {
  // A curva de referência do mercado (ADR 0019): piso e teto seguem
  // `área^0,85 × fps^0,55`, não bits por pixel constante.
  const { width, height } = PRESETS[presetId];
  return Math.round(tetoDeBitrate(width, height, fps));
}

function bppDe(bps, presetId, fps = 60) {
  const { width, height } = PRESETS[presetId];
  return bps / (width * height * fps);
}

/**
 * O que um controlador PERFEITO entregaria, dado o mesmo link.
 *
 * Usa as funções reais: mesma `UPLINK_SHARE`, mesma escada, mesmo teto de bpp.
 * É contra este número que "ficou preso abaixo do que o link pagava" é medido.
 */
function referenciaIdeal(upBps, peers) {
  const n = Math.max(1, peers.length);
  const porEspectador = Math.min(...peers.map((p) => Math.min(upBps / n, p.downBps)));
  const orcamento = Math.max(300_000, Math.round(porEspectador * UPLINK_SHARE));
  const preset = presetParaOrcamento(orcamento, 'fluidez');
  const bitrate = Math.min(orcamento, tetoUtil(preset));
  return { orcamento, preset, bitrate, bpp: bppDe(bitrate, preset) };
}

/** Perfil de pressão de CPU: devolve `true` quando a amostra vem com `cpu`. */
function fabricaCpu(modo, rng) {
  if (modo === 'nenhuma') return () => false;
  if (modo === 'blips5') return () => rng() < 0.05;
  // 20% sustentada: 60 segundos contíguos, de t=100 a t=160.
  return (t) => t >= 100 && t < 160;
}

async function rodarCenario(cfg) {
  const rng = mulberry32(cfg.sementeRng ?? 12345);
  const peers = cfg.peers.map((p, i) => ({ ...p, id: `v_${i + 1}` }));
  const rede = new Rede({ ...cfg, peers, iceMs: ICE_MS, tempoAgora: 0 }, rng);
  const transport = new SimTransport(rede, cfg);
  const scheduler = new FakeScheduler();
  const screen = new FakeScreenCapture();
  const memoria =
    cfg.sementeUplink === null
      ? undefined
      : {
          valor: String(Math.round(cfg.sementeUplink)),
          read() {
            return this.valor;
          },
          write(v) {
            this.valor = v;
          },
        };

  const session = new BroadcastSession({
    transport,
    screen,
    audio: new FakeAudioCapture(),
    gain: new FakeAudioGain(),
    scheduler,
    shareUrlFor,
    createStream,
    ...(memoria === undefined ? {} : { uplinkMemory: memoria }),
    statsIntervalMs: 1_000,
    capacidade: CAPACIDADE,
  });

  await session.start('sim', 'o'.repeat(43));
  await assentar();
  if (session.getState().status !== 'live') {
    throw new Error(`sessão não subiu: ${JSON.stringify(session.getState())}`);
  }

  const cpuAtiva = fabricaCpu(cfg.cpu, rng);
  const serie = [];
  let anterior = null;
  let reconfigs = 0;
  let ultimaMudanca = 0;
  /**
   * Quando o PRIMEIRO orçamento chegou ao encoder.
   *
   * Enquanto ele não chega, `MeshTopology.orcamento` é `null`, o encoder recebe
   * o TETO ÚTIL do preset (24,9 Mbps em 1080p60) e `presetPorBanda` é `null` —
   * a banda não restringe resolução nenhuma. Sem semente isto acontece no
   * nono segundo depois do primeiro peer medir; COM semente pode nunca
   * acontecer, e é aí que mora o defeito.
   */
  let tPrimeiroOrcamento = null;

  for (let t = 1; t <= DURACAO_S; t += 1) {
    rede.cfg.tempoAgora = t;

    // Entradas, recusas e conexões deste segundo.
    transport.t = t;
    for (const p of rede.peers) {
      if (p.admitidoEm === null && t >= p.proximaTentativa) {
        if (transport.temVaga()) {
          p.admitidoEm = t;
          p.conectaEm = t + ICE_MS / 1000;
          transport.admitir(p);
          await assentar(2);
        } else {
          transport.recusar(p, t);
        }
      }
      if (!p.conectado && p.conectaEm !== null && t >= p.conectaEm) {
        transport.conectar(p);
        await assentar(2);
      }
    }

    const enc = transport.maxBitrateNoSender();
    const maxBitrate = enc?.maxBitrate ?? presetById('p1080p60').main.maxBitrate;
    const cpu = cpuAtiva(t);

    rede.tique(t, 1, maxBitrate, cpu);

    transport.prepararStats(t, (peer) => {
      if (cpu) return 'cpu';
      // O Chromium reporta `bandwidth` quando é o BWE, e não o nosso teto, que
      // amarra o encoder — ou quando há sobreuso de verdade.
      if (peer.sobreuso) return 'bandwidth';
      if (Math.min(peer.bwe, maxBitrate) < maxBitrate * 0.98) return 'bandwidth';
      return 'none';
    });

    scheduler.advance(1_000);
    await assentar(3);

    const estado = session.getState();
    const encDepois = transport.maxBitrateNoSender();
    const conectados = rede.peers.filter((p) => p.conectado);
    if (tPrimeiroOrcamento === null && transport.orcamentos.length > 0) tPrimeiroOrcamento = t;
    const presetAtual = estado.status === 'live' ? estado.presetId : null;
    const bitrateAtual = encDepois?.maxBitrate ?? null;
    const chave = `${presetAtual}|${bitrateAtual}`;
    if (anterior !== null && chave !== anterior) {
      reconfigs += 1;
      ultimaMudanca = t;
    }
    anterior = chave;

    serie.push({
      t,
      preset: presetAtual,
      maxBitrate: bitrateAtual,
      escala: encDepois?.scaleResolutionDownBy ?? null,
      bppPedido: transport.topology.bppAtual(),
      bppMedido: estado.status === 'live' ? (estado.stats?.bpp ?? null) : null,
      orcamento: transport.orcamentos.at(-1) ?? null,
      limitacao: estado.status === 'live' ? (estado.stats?.limitation ?? null) : null,
      motivo: estado.status === 'live' ? estado.motivoDegradacao : null,
      bweMin: conectados.length === 0 ? null : Math.min(...conectados.map((p) => p.bwe)),
      sobreuso: conectados.some((p) => p.sobreuso),
      sobrecarga:
        conectados.length === 0 ? 1 : Math.max(...conectados.map((p) => p.sobrecarga ?? 1)),
      upEm: rede.upEm(t),
      vagas: transport.teto,
      conectados: conectados.length,
    });
  }

  const ultimo = serie.at(-1);
  /**
   * A referência é sobre quem ENTROU (ADR 0030): a porta pela banda deixa de
   * fora quem levaria todos abaixo do piso, e comparar 27 admitidos com o que
   * o link pagaria para 50 diria "melhor que o ideal" sem dizer nada.
   */
  const admitidos = peers.filter((p, i) => rede.peers[i].admitidoEm !== null);
  const ideal = referenciaIdeal(rede.upEm(DURACAO_S), admitidos.length > 0 ? admitidos : peers);
  const recusados = peers.length - admitidos.length;
  const atrasos = rede.peers.filter((p) => p.admitidoEm !== null).map((p) => p.admitidoEm - p.entraEm);
  const atrasoMax = atrasos.length === 0 ? 0 : Math.max(...atrasos);
  /*
    "O link pagava todos": a conta da porta sobre a capacidade VERDADEIRA. Se
    deu CHANNEL_FULL definitivo aqui, a porta recusou quem cabia — regressão.
  */
  const hasAudio = session.getState().status === 'live' && session.getState().hasAudio;
  const pisoPorPessoa = pisoPorEspectador('fluidez', hasAudio ? 141_000 : 0);
  const menorDescida = Math.min(...peers.map((p) => p.downBps));
  const linkPagavaTodos =
    Math.min(rede.upEm(DURACAO_S) / peers.length, menorDescida) * UPLINK_SHARE >= pisoPorPessoa;
  const bppFinal = ultimo.bppPedido ?? 0;

  // Estado absorvente: chegou ao pior degrau e nunca mais subiu de lá.
  const idxPior = Math.max(...serie.map((s) => (s.preset === null ? -1 : PRESET_IDS.indexOf(s.preset))));
  const piorPreset = PRESET_IDS[idxPior] ?? 'p1080p60';
  const primeiraVezNoFundo = serie.find((s) => s.preset === piorPreset)?.t ?? DURACAO_S;
  const subiuDepois = serie.some(
    (s) => s.t > primeiraVezNoFundo && s.preset !== null && PRESET_IDS.indexOf(s.preset) < idxPior,
  );
  // Só conta como absorvente se ficar ABAIXO do que o link pagava.
  const absorvente =
    !subiuDepois &&
    PRESET_IDS.indexOf(ultimo.preset ?? 'p360p60') > PRESET_IDS.indexOf(ideal.preset) &&
    primeiraVezNoFundo < DURACAO_S - 30;

  // Só depois do aquecimento: os primeiros segundos sondam por construção.
  const regime = serie.filter((s) => s.t > 15);
  const ticksSobreuso = regime.filter((s) => s.sobreuso).length;

  /**
   * O governador NUNCA falou em 300 segundos.
   *
   * Não é curiosidade: sem uma decisão, `MeshTopology.orcamento` continua
   * `null`, `effectiveBitrate` devolve o TETO ÚTIL do preset (24,9 Mbps em
   * 1080p60) e `presetPorBanda` fica `null` — a banda deixa de restringir
   * qualquer coisa. É o pior estado possível, e ele é silencioso.
   */
  const mudo = transport.orcamentos.length === 0;

  /**
   * O bpp que de fato ATRAVESSA, medido pelo `StatsSampler` real a partir de
   * `bytesSent`. Diferente de `bppAtual()`, que é o bpp PEDIDO.
   *
   * Quando os dois divergem, quem prevê a imagem quebrada é este.
   */
  const bppEntregue = ultimo.bppMedido ?? 0;
  const pctAbaixoPiso =
    regime.length === 0
      ? 0
      : (100 * regime.filter((s) => (s.bppMedido ?? 0) < BPP_PISO).length) / regime.length;

  return {
    id: cfg.id,
    cfg,
    serie,
    finalPreset: ultimo.preset,
    finalBitrate: ultimo.maxBitrate,
    finalBpp: bppFinal,
    bppMedido: ultimo.bppMedido,
    escala: ultimo.escala,
    reconfigs,
    tEstabiliza: ultimaMudanca,
    roundsSetParams: transport.orcamentos.length + transport.presetsAplicados.length,
    ideal,
    /**
     * `bpp` sozinho NÃO mede qualidade, e usar só ele premia descer de degrau:
     * p480p60 a 0,126 bpp tem bpp MAIOR que p1080p60 a 0,121 e é visivelmente
     * pior. As duas medidas juntas é que dizem a verdade — quantos degraus de
     * resolução se perdeu, e quanto do bitrate que o link pagava chegou.
     */
    degrausPerdidos:
      PRESET_IDS.indexOf(ultimo.preset ?? 'p360p60') - PRESET_IDS.indexOf(ideal.preset),
    razaoBitrate: ideal.bitrate > 0 ? (ultimo.maxBitrate ?? 0) / ideal.bitrate : 1,
    razao: ideal.bpp > 0 ? bppFinal / ideal.bpp : 1,
    deficitBps: ideal.bitrate - (ultimo.maxBitrate ?? 0),
    motivo: ultimo.motivo,
    piorPreset,
    absorvente,
    mudo,
    tPrimeiroOrcamento,
    bppEntregue,
    pctAbaixoPiso,
    pctSobreuso: regime.length === 0 ? 0 : (100 * ticksSobreuso) / regime.length,
    picoSobrecarga: Math.max(1, ...regime.map((s) => s.sobrecarga)),
    admitidos: admitidos.length,
    recusados,
    recusadoIndevido: recusados > 0 && linkPagavaTodos,
    atrasoMax,
    vagasFinais: transport.teto,
    mudancasDeVagas: transport.capacidades.length,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   6. A MATRIZ
   ═══════════════════════════════════════════════════════════════════════ */

const UPLOADS = [5, 10, 20, 50, 100, 300, 800];
const ESPECTADORES = ESCALA ? [10, 20, 50] : [1, 2, 3, 5];
const DESCIDA_NORMAL = Mbps(500);
const DESCIDA_FRACA = Mbps(5);
const CPUS = ['nenhuma', 'blips5', 'sustentada20'];
const ENTRADAS = ['juntos', 'escalonada'];
const SEMENTES = ['ausente', 'correta', 'errada-alta', 'errada-baixa'];

function montarPeers(n, comFraco, entrada) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const fraco = comFraco && (n === 1 ? i === 0 : i === Math.floor(n / 2));
    out.push({
      downBps: fraco ? DESCIDA_FRACA : DESCIDA_NORMAL,
      // Todos de uma vez em t=1; escalonada com 1s de diferença.
      entraEm: entrada === 'juntos' ? 1 : 1 + i,
    });
  }
  return out;
}

function valorSemente(modo, upBps, peers) {
  if (modo === 'ausente') return null;
  const menorDescida = Math.min(...peers.map((p) => p.downBps));
  const n = peers.length;
  // A semente gravada é `governor.estimativa`, ou seja a banda POR ESPECTADOR.
  if (modo === 'correta') return Math.min(upBps / n, menorDescida);
  // Gravada com 1 espectador, replantada com N: alta demais por um fator N.
  if (modo === 'errada-alta') return Math.min(upBps / 1, menorDescida);
  // Gravada com 5 espectadores, replantada com N: baixa demais.
  return Math.min(upBps / 5, menorDescida);
}

function montarMatriz() {
  const uploads = RAPIDO ? [10, 100, 800] : UPLOADS;
  const espectadores = RAPIDO ? [1, 5] : ESPECTADORES;
  const cpus = RAPIDO ? ['nenhuma', 'sustentada20'] : CPUS;
  const entradas = RAPIDO ? ['juntos'] : ENTRADAS;
  const sementes = RAPIDO ? ['ausente', 'errada-alta'] : SEMENTES;

  const casos = [];
  for (const up of uploads) {
    for (const n of espectadores) {
      for (const fraco of [false, true]) {
        for (const cpu of cpus) {
          for (const entrada of entradas) {
            // Entrada escalonada não existe com um espectador só.
            if (n === 1 && entrada === 'escalonada') continue;
            for (const semente of sementes) {
              const peers = montarPeers(n, fraco, entrada);
              casos.push({
                id: `up${up}-n${n}-${fraco ? 'fraco' : 'iguais'}-${cpu}-${entrada}-${semente}`,
                upBps: Mbps(up),
                upMbps: up,
                n,
                fraco,
                cpu,
                entrada,
                semente,
                peers,
                sementeUplink: valorSemente(semente, Mbps(up), peers),
                quedas: [],
              });
            }
          }
        }
      }
    }
  }
  return casos;
}

/** Sub-matriz de queda sustentada: o link cai a 15% por 30s no meio da sessão. */
function montarQuedas() {
  const casos = [];
  for (const up of [10, 50, 300, 800]) {
    for (const n of [1, 3, 5]) {
      for (const semente of ['ausente', 'correta']) {
        const peers = montarPeers(n, false, 'juntos');
        casos.push({
          id: `QUEDA-up${up}-n${n}-${semente}`,
          upBps: Mbps(up),
          upMbps: up,
          n,
          fraco: false,
          cpu: 'nenhuma',
          entrada: 'juntos',
          semente,
          peers,
          sementeUplink: valorSemente(semente, Mbps(up), peers),
          quedas: [{ de: 120, ate: 150, fator: 0.15 }],
        });
      }
    }
  }
  return casos;
}

/**
 * O defeito da TELA-015 exatamente: o link CAI e FICA. A queda de 30 s acima
 * mede reação e volta; esta mede se a transmissão desce e para no degrau que
 * o link paga — em vez de ficar a 1080p60 com 0,02 bpp e a tela calada.
 */
function montarColapsos() {
  const casos = [];
  for (const up of [50, 300]) {
    for (const n of [1, 3, 5]) {
      const peers = montarPeers(n, false, 'juntos');
      casos.push({
        id: `COLAPSO-up${up}-n${n}`,
        upBps: Mbps(up),
        upMbps: up,
        n,
        fraco: false,
        cpu: 'nenhuma',
        entrada: 'juntos',
        semente: 'ausente',
        peers,
        sementeUplink: valorSemente('ausente', Mbps(up), peers),
        quedas: [{ de: 120, ate: Number.POSITIVE_INFINITY, fator: 0.1 }],
      });
    }
  }
  return casos;
}

/* ═══════════════════════════════════════════════════════════════════════
   7. RELATÓRIO
   ═══════════════════════════════════════════════════════════════════════ */

const PREMISSAS = `
PREMISSAS DO MODELO — e onde ele pode estar errado
──────────────────────────────────────────────────────────────────────────
P1  AIMD. Subida multiplicativa de 8%/s, recuo para 0,85×acked no sobreuso, e
    o clamp duro em 1,5×acked + 10 kbps. É o AimdRateControl do libwebrtc em
    granularidade de 1 s, não de RTT. Em RTT de 20 ms o libwebrtc real faz
    ~50 atualizações por segundo, então a SUBIDA real é bem mais rápida que a
    daqui. ONDE ERRA: o simulador é PESSIMISTA no tempo de subida e OTIMISTA
    na suavidade — não modela as oscilações de sub-segundo que a média móvel
    do governador vê.

P2  Ruído. ±20% uniforme e independente por amostra sobre a estimativa. NO
    PADRÃO ele não é reclampado no teto do AIMD — é a leitura literal do
    enunciado, e a mais generosa com o produto: metade das amostras sai acima
    de 1,5×acked, o que é justamente a porta de saída da catraca da ADR 0018.
    \`--clamp-duro\` reclampa, que é a leitura estrita de \`ClampBitrate\`, e
    puxa a média da estimativa de 1,50×acked para 1,425×acked. ONDE ERRA:
    ruído real é correlacionado, não independente; a média móvel do governador
    filtra ruído branco muito melhor do que filtra ruído correlacionado.
    A diferença entre os dois modos é grande — ver o comparativo.

P3  Partilha do uplink. Max-min entre os senders ativos. ONDE ERRA: não há
    bufferbloat modelado — a fila do roteador não enche nem atrasa; o sobreuso
    é detectado no mesmo segundo. O produto real leva de 100 a 500 ms para
    perceber, e nesse meio-tempo o ping do jogo já subiu.

P4  CPU. Só o canal \`qualityLimitationReason: 'cpu'\`. O encoder continua
    entregando o alvo em bits. ONDE ERRA: encode em software de verdade também
    derruba fps e bitrate efetivo, o que deprimiria \`acked\` e, por P1,
    baixaria o teto do estimador. \`--cpu-cobra\` cobra 10% do \`acked\`.
    "blips 5%" = 5% de amostras independentes com \`cpu\`; "sustentada 20%" =
    60 segundos contíguos (t=100..160), 20% dos 300s, com \`cpu\` em todas.

P5  Conteúdo. O encoder SEMPRE consome o alvo inteiro (movimento alto, CBR).
    ONDE ERRA: cena parada gasta menos, \`acked\` cai sem que a rede tenha
    piorado, e o teto de 1,5×acked desce junto. Este é o caminho mais provável
    para a catraca aparecer em campo e ele NÃO está simulado — o simulador é
    otimista aqui.

P6  Descida do espectador "normal" = 500 Mbps, para que o uplink seja o gargalo
    em "todos iguais". O espectador fraco tem 5 Mbps. ONDE ERRA: não modela
    perda de pacote residual nem Wi-Fi ruim do lado de quem assiste.

P7  A referência "o que o link pagava" usa as funções REAIS
    (UPLINK_SHARE, presetParaOrcamento, BPP_TETO) sobre a capacidade
    verdadeira. É o teto do próprio produto, não um ideal inventado — e é
    sobre quem ENTROU, porque a porta pela banda (P8) pode deixar gente fora.

P8  Porta pela banda (ADR 0030). A sessão REAL calcula quantos o link paga e
    manda ao servidor; aqui o transporte faz o papel do servidor: quem pede
    vaga acima do teto recebe CHANNEL_FULL e tenta de novo com o backoff do
    \`ViewerSession\` real (7,5 s, 16,9 s, 30 s…). ONDE ERRA: o servidor real
    admite em ordem de chegada do socket; aqui é a ordem da lista. E 50
    pessoas clicando no MESMO segundo é o pior caso — no mundo real a chegada
    se espalha e a porta mede entre uma leva e outra.
`;

function tabela(linhas, colunas) {
  const larg = colunas.map((c) =>
    Math.max(c.titulo.length, ...linhas.map((l) => String(c.valor(l)).length)),
  );
  const sep = colunas.map((_, i) => '─'.repeat(larg[i])).join('─┼─');
  const cab = colunas.map((c, i) => c.titulo.padEnd(larg[i])).join(' │ ');
  const corpo = linhas.map((l) =>
    colunas.map((c, i) => String(c.valor(l)).padEnd(larg[i])).join(' │ '),
  );
  return [cab, sep, ...corpo].join('\n');
}

async function main() {
  if (flag('premissas')) {
    console.log(PREMISSAS);
    return null;
  }

  // Os colapsos só entram em `--quedas`: a matriz de 1200 fica comparável com
  // as rodadas anteriores.
  const casos = SO_QUEDAS
    ? [...montarQuedas(), ...montarColapsos()]
    : [...montarMatriz(), ...montarQuedas()];
  console.log(
    `\nSIMULADOR DAS MALHAS — ${casos.length} cenários × ${DURACAO_S}s` +
      `${CLAMP_DURO || CPU_COBRA ? `  [${CLAMP_DURO ? 'clamp-duro ' : ''}${CPU_COBRA ? 'cpu-cobra' : ''}]` : ''}\n`,
  );

  const resultados = [];
  const inicio = Date.now();
  for (let i = 0; i < casos.length; i += 1) {
    const r = await rodarCenario({ ...casos[i], sementeRng: 1000 + i });
    resultados.push(r);
    // Depuração: `SERIE=<id do cenário>` imprime a série segundo a segundo.
    if (process.env.SERIE === r.id) {
      for (const p of r.serie) {
        console.log(JSON.stringify({ ...p, maxBitrate: p.maxBitrate, orcamento: p.orcamento }));
      }
    }
    if ((i + 1) % 50 === 0 || i + 1 === casos.length) {
      const s = ((Date.now() - inicio) / 1000).toFixed(0);
      process.stdout.write(`\r  ${i + 1}/${casos.length} cenários  (${s}s)   `);
    }
  }
  console.log('\n');

  if (TRACE !== null) {
    const alvo = resultados.find((r) => r.id === TRACE);
    if (alvo === undefined) {
      console.log(`Cenário "${TRACE}" não existe. Exemplos: ${resultados.slice(0, 3).map((r) => r.id).join(', ')}`);
    } else {
      console.log(`SÉRIE TEMPORAL — ${alvo.id}\n`);
      console.log(
        tabela(
          alvo.serie.filter((s) => s.t <= 40 || s.t % 10 === 0),
          [
            { titulo: 't', valor: (s) => s.t },
            { titulo: 'preset', valor: (s) => s.preset ?? '—' },
            { titulo: 'maxBitrate', valor: (s) => emMbps(s.maxBitrate) },
            { titulo: 'bpp ped', valor: (s) => (s.bppPedido ?? 0).toFixed(4) },
            { titulo: 'bpp entr', valor: (s) => (s.bppMedido ?? 0).toFixed(4) },
            { titulo: 'orcamento', valor: (s) => emMbps(s.orcamento) },
            { titulo: 'bwe_min', valor: (s) => emMbps(s.bweMin) },
            { titulo: 'cap', valor: (s) => emMbps(s.upEm) },
            { titulo: 'N', valor: (s) => s.conectados },
            { titulo: 'vagas', valor: (s) => s.vagas },
            { titulo: 'sobre', valor: (s) => (s.sobreuso ? `${s.sobrecarga.toFixed(2)}x` : '—') },
            { titulo: 'lim', valor: (s) => s.limitacao ?? '—' },
            { titulo: 'motivo', valor: (s) => s.motivo ?? '—' },
          ],
        ),
      );
      console.log(
        `  admitidos ${alvo.admitidos}/${alvo.cfg.n} · recusados ${alvo.recusados}` +
          ` · maior atraso de entrada ${alvo.atrasoMax}s · vagas no fim ${alvo.vagasFinais}\n`,
      );
    }
  }

  const arquivo = join(AQUI, 'malhas.sim.json');
  writeFileSync(
    arquivo,
    JSON.stringify(
      resultados.map((r) => ({
        id: r.id,
        up: r.cfg.upMbps,
        n: r.cfg.n,
        fraco: r.cfg.fraco,
        cpu: r.cfg.cpu,
        entrada: r.cfg.entrada,
        semente: r.cfg.semente,
        finalPreset: r.finalPreset,
        finalBitrate: r.finalBitrate,
        finalBpp: Number(r.finalBpp.toFixed(5)),
        bppMedido: r.bppMedido === null ? null : Number(r.bppMedido.toFixed(5)),
        idealPreset: r.ideal.preset,
        idealBitrate: r.ideal.bitrate,
        idealBpp: Number(r.ideal.bpp.toFixed(5)),
        razao: Number(r.razao.toFixed(4)),
        degrausPerdidos: r.degrausPerdidos,
        razaoBitrate: Number(r.razaoBitrate.toFixed(4)),
        reconfigs: r.reconfigs,
        tEstabiliza: r.tEstabiliza,
        roundsSetParams: r.roundsSetParams,
        piorPreset: r.piorPreset,
        absorvente: r.absorvente,
        mudo: r.mudo,
        tPrimeiroOrcamento: r.tPrimeiroOrcamento,
        bppEntregue: Number(r.bppEntregue.toFixed(5)),
        pctAbaixoPiso: Number(r.pctAbaixoPiso.toFixed(1)),
        pctSobreuso: Number(r.pctSobreuso.toFixed(1)),
        picoSobrecarga: Number(r.picoSobrecarga.toFixed(3)),
        admitidos: r.admitidos,
        recusados: r.recusados,
        recusadoIndevido: r.recusadoIndevido,
        atrasoMax: r.atrasoMax,
        vagasFinais: r.vagasFinais,
      })),
      null,
      1,
    ),
  );

  /* ── 1. sumário ── */
  /**
   * O quadriculado é previsto pelo bpp ENTREGUE, não pelo pedido.
   *
   * Um cenário pode pedir 0,20 bpp em 1080p60 e entregar 0,017 porque o link
   * não tem nada disso — e é justamente esse o caso mais grave, porque o
   * número que a UI mostra parece ótimo.
   */
  const quadriculado = resultados.filter((r) => r.bppEntregue < BPP_PISO || r.pctAbaixoPiso >= 50);
  const mudos = resultados.filter((r) => r.mudo);
  const mentindo = resultados.filter((r) => r.finalBpp >= BPP_PISO && r.bppEntregue < BPP_PISO);
  /**
   * "Muito abaixo do que o link comportava" = perdeu degrau de resolução OU
   * recebeu menos de 80% dos bits que o link pagava. Um só dos dois não basta:
   * descer de degrau pode até subir o bpp, e ficar no degrau certo com metade
   * dos bits é o "embaçou" clássico.
   */
  const abaixoDoLink = resultados.filter((r) => r.degrausPerdidos >= 1 || r.razaoBitrate < 0.8);
  const instaveis = resultados.filter((r) => r.reconfigs > 5);
  const absorventes = resultados.filter((r) => r.absorvente);
  const afogando = resultados.filter((r) => r.pctSobreuso > 10);

  console.log('═'.repeat(78));
  console.log(`SUMÁRIO${CLAMP_DURO || CPU_COBRA ? `  [${CLAMP_DURO ? 'clamp-duro ' : ''}${CPU_COBRA ? 'cpu-cobra' : ''}]` : '  [premissas padrão]'}`);
  console.log('═'.repeat(78));
  console.log(`  cenários                                       ${resultados.length}`);
  console.log(`  bpp ENTREGUE < ${BPP_PISO} (quadriculado)             ${quadriculado.length}`);
  console.log(`  bpp pedido ok mas bpp entregue < ${BPP_PISO}          ${mentindo.length}   ← o rótulo mente`);
  console.log(`  governador NUNCA emitiu orçamento em ${DURACAO_S}s      ${mudos.length}`);
  console.log(
    `  tempo até o 1º orçamento chegar ao encoder:   mediana ` +
      `${mediana(resultados.map((r) => r.tPrimeiroOrcamento ?? DURACAO_S))}s` +
      `  p90 ${percentil(resultados.map((r) => r.tPrimeiroOrcamento ?? DURACAO_S), 0.9)}s` +
      `  max ${Math.max(...resultados.map((r) => r.tPrimeiroOrcamento ?? DURACAO_S))}s`,
  );
  console.log(
    `  % do tempo com bpp entregue < ${BPP_PISO}:          mediana ` +
      `${mediana(resultados.map((r) => r.pctAbaixoPiso)).toFixed(0)}%` +
      `  p90 ${percentil(resultados.map((r) => r.pctAbaixoPiso), 0.9).toFixed(0)}%`,
  );
  console.log(`  qualidade < 80% do que o link pagava           ${abaixoDoLink.length}`);
  console.log(`  > 5 reconfigurações de encoder em ${DURACAO_S}s          ${instaveis.length}`);
  console.log(`  estado absorvente (desceu e nunca voltou)      ${absorventes.length}`);
  console.log(`  > 10% do tempo pedindo mais do que o link tem  ${afogando.length}`);
  console.log(
    `  reconfigurações: min ${Math.min(...resultados.map((r) => r.reconfigs))}` +
      `  mediana ${mediana(resultados.map((r) => r.reconfigs))}` +
      `  p90 ${percentil(resultados.map((r) => r.reconfigs), 0.9)}` +
      `  max ${Math.max(...resultados.map((r) => r.reconfigs))}`,
  );
  console.log(
    `  tempo até estabilizar: mediana ${mediana(resultados.map((r) => r.tEstabiliza))}s` +
      `  p90 ${percentil(resultados.map((r) => r.tEstabiliza), 0.9)}s` +
      `  max ${Math.max(...resultados.map((r) => r.tEstabiliza))}s`,
  );
  {
    const porN = ESPECTADORES.map((n) => {
      const g = resultados.filter((r) => r.cfg.n === n);
      return `N=${n}:${mediana(g.map((r) => r.reconfigs))}`;
    });
    console.log(`  reconfigurações medianas por nº de espectadores: ${porN.join('  ')}`);
  }
  console.log(
    `  sobreuso em regime: mediana ${mediana(resultados.map((r) => r.pctSobreuso)).toFixed(1)}%` +
      `  p90 ${percentil(resultados.map((r) => r.pctSobreuso), 0.9).toFixed(1)}%` +
      `  pico de sobrecarga ${Math.max(...resultados.map((r) => r.picoSobrecarga)).toFixed(2)}×`,
  );
  {
    const comRecusa = resultados.filter((r) => r.recusados > 0);
    const indevidos = resultados.filter((r) => r.recusadoIndevido);
    const atrasados = resultados.filter((r) => r.atrasoMax > 0);
    console.log(
      `  porta pela banda (ADR 0030): recusou em ${comRecusa.length} cenários` +
        ` (${indevidos.length} onde o link pagava todos)` +
        `  entrada atrasada em ${atrasados.length}` +
        `  atraso máx p90 ${percentil(resultados.map((r) => r.atrasoMax), 0.9)}s` +
        `  max ${Math.max(...resultados.map((r) => r.atrasoMax))}s`,
    );
  }
  console.log();

  /* ── 2. matriz por upload × espectadores ── */
  console.log('═'.repeat(78));
  console.log('MATRIZ — bpp FINAL POR UPLOAD × ESPECTADORES × ESPECTADOR FRACO');
  console.log('  pior e melhor entre as combinações de CPU, entrada e semente do grupo');
  console.log('═'.repeat(78));
  const grupos = new Map();
  for (const r of resultados) {
    if (r.cfg.quedas.length > 0) continue;
    const k = `${r.cfg.upMbps}|${r.cfg.n}|${r.cfg.fraco}`;
    const g = grupos.get(k) ?? [];
    g.push(r);
    grupos.set(k, g);
  }
  const linhasMatriz = [];
  const rotulo = (r) =>
    [r.cfg.cpu, r.cfg.entrada, r.cfg.semente].join('/');
  for (const up of UPLOADS) {
    for (const n of ESPECTADORES) {
      for (const fraco of [false, true]) {
        const g = grupos.get(`${up}|${n}|${fraco}`);
        if (g === undefined) continue;
        // O PIOR do grupo é o que entregou menos bits do que o link pagava,
        // com empate desfeito por degraus de resolução perdidos.
        const pior = [...g].sort(
          (a, b) => a.razaoBitrate - b.razaoBitrate || b.degrausPerdidos - a.degrausPerdidos,
        )[0];
        const melhor = [...g].sort((a, b) => b.razaoBitrate - a.razaoBitrate)[0];
        linhasMatriz.push({
          up,
          n,
          fraco: fraco ? 'sim' : '—',
          ideal: `${pior.ideal.preset} ${emMbps(pior.ideal.bitrate)}`,
          piorPreset: pior.finalPreset,
          piorMbps: emMbps(pior.finalBitrate),
          piorBpp: pior.finalBpp,
          piorEntregue: pior.bppEntregue,
          piorRuim: Math.max(...g.map((r) => r.pctAbaixoPiso)),
          piorOrc: Math.max(...g.map((r) => r.tPrimeiroOrcamento ?? DURACAO_S)),
          mudos: g.filter((r) => r.mudo).length,
          degraus: pior.degrausPerdidos,
          razaoBits: pior.razaoBitrate,
          melhorBits: melhor.razaoBitrate,
          quem: rotulo(pior),
          recfg: Math.max(...g.map((r) => r.reconfigs)),
          sobre: Math.max(...g.map((r) => r.pctSobreuso)),
        });
      }
    }
  }
  console.log(
    tabela(linhasMatriz, [
      { titulo: 'up', valor: (l) => l.up },
      { titulo: 'N', valor: (l) => l.n },
      { titulo: 'fraco', valor: (l) => l.fraco },
      { titulo: 'ideal', valor: (l) => l.ideal },
      { titulo: 'pior degrau', valor: (l) => l.piorPreset },
      { titulo: 'Mbps', valor: (l) => l.piorMbps },
      { titulo: 'bpp ped', valor: (l) => l.piorBpp.toFixed(4) },
      { titulo: 'bpp entr', valor: (l) => l.piorEntregue.toFixed(4) },
      { titulo: '%ruim', valor: (l) => l.piorRuim.toFixed(0) },
      { titulo: '1ºorc', valor: (l) => `${l.piorOrc}s` },
      { titulo: 'mudo', valor: (l) => (l.mudos > 0 ? `${l.mudos}` : '') },
      { titulo: 'degraus', valor: (l) => (l.degraus > 0 ? `-${l.degraus}` : '0') },
      { titulo: 'bits/ideal', valor: (l) => l.razaoBits.toFixed(2) },
      { titulo: 'melhor', valor: (l) => l.melhorBits.toFixed(2) },
      { titulo: 'recfg', valor: (l) => l.recfg },
      { titulo: '%sobre', valor: (l) => l.sobre.toFixed(0) },
      { titulo: 'pior caso', valor: (l) => l.quem },
      {
        titulo: 'flag',
        valor: (l) =>
          l.piorEntregue < BPP_PISO || l.piorRuim >= 50
            ? '◄ QUADRICULADO'
            : l.degraus >= 1 || l.razaoBits < 0.8
              ? '◄ abaixo do link'
              : '',
      },
    ]),
  );
  console.log();

  /* ── 3. piores casos ── */
  imprimirLista(
    'CENÁRIOS COM bpp ENTREGUE ABAIXO DE 0,10 — o quadriculado',
    quadriculado.sort((a, b) => a.bppEntregue - b.bppEntregue),
  );
  imprimirLista(
    'GOVERNADOR MUDO — nenhuma decisão em 300s, orçamento nunca chega ao encoder',
    mudos.sort((a, b) => b.pctAbaixoPiso - a.pctAbaixoPiso),
  );
  const lentos = resultados.filter(
    (r) => !r.mudo && (r.tPrimeiroOrcamento ?? 0) > 20,
  );
  imprimirLista(
    'ORÇAMENTO ATRASADO — mais de 20s até o encoder receber o primeiro orçamento',
    lentos.sort((a, b) => (b.tPrimeiroOrcamento ?? 0) - (a.tPrimeiroOrcamento ?? 0)),
  );
  imprimirLista(
    'CENÁRIOS MUITO ABAIXO DO QUE O LINK PAGAVA (< 80% do bpp ideal)',
    abaixoDoLink.sort(
      (a, b) => b.degrausPerdidos - a.degrausPerdidos || a.razaoBitrate - b.razaoBitrate,
    ),
  );
  imprimirLista(
    'MALHA INSTÁVEL (> 5 reconfigurações de encoder em 300s)',
    instaveis.sort((a, b) => b.reconfigs - a.reconfigs),
  );
  imprimirLista(
    'ESTADO ABSORVENTE — desceu de degrau, nunca voltou, e o link pagava mais',
    absorventes.sort((a, b) => b.degrausPerdidos - a.degrausPerdidos),
  );
  imprimirLista(
    'AFOGANDO O LINK — > 10% das amostras pedindo mais do que a capacidade real',
    afogando.sort((a, b) => b.pctSobreuso - a.pctSobreuso),
  );
  imprimirLista(
    'PORTA FECHADA INDEVIDAMENTE — recusou gente que o link pagava',
    resultados.filter((r) => r.recusadoIndevido).sort((a, b) => b.recusados - a.recusados),
  );

  /* ── 4. efeito de cada eixo ── */
  console.log('═'.repeat(78));
  console.log('EFEITO ISOLADO DE CADA EIXO  (média de bitrate_final / bitrate_ideal, teto 1)');
  console.log('═'.repeat(78));
  for (const eixo of ['cpu', 'semente', 'entrada', 'fraco', 'n']) {
    const porValor = new Map();
    for (const r of resultados) {
      if (r.cfg.quedas.length > 0) continue;
      const v = String(r.cfg[eixo]);
      const g = porValor.get(v) ?? [];
      g.push(r);
      porValor.set(v, g);
    }
    const partes = [...porValor.entries()]
      .sort()
      .map(([v, g]) => {
        const media = g.reduce((s, r) => s + Math.min(1, r.razaoBitrate), 0) / g.length;
        const ruins = g.filter((r) => r.bppEntregue < BPP_PISO).length;
        const mudez = g.filter((r) => r.mudo).length;
        return `${v}=${media.toFixed(3)} (${ruins} quadric., ${mudez} mudos)`;
      });
    console.log(`  ${eixo.padEnd(9)} ${partes.join('   ')}`);
  }
  console.log();

  /* ── 5. quedas ── */
  const colapsos = resultados.filter((r) => r.cfg.quedas.some((q) => q.ate > DURACAO_S));
  const quedas = resultados.filter(
    (r) => r.cfg.quedas.length > 0 && !r.cfg.quedas.some((q) => q.ate > DURACAO_S),
  );
  if (colapsos.length > 0) {
    console.log('═'.repeat(78));
    console.log('COLAPSO SUSTENTADO — link cai a 10% em t=120s e FICA (TELA-015)');
    console.log('═'.repeat(78));
    console.log(
      tabela(
        colapsos.map((r) => {
          const antes = r.serie.find((s) => s.t === 119);
          const depois = r.serie.at(-1);
          const reacao = r.serie.find((s) => s.t > 120 && (s.maxBitrate ?? 0) < (antes.maxBitrate ?? 0) * 0.9);
          return { id: r.id, antes, depois, reacao: reacao === undefined ? 'NUNCA' : `${reacao.t - 120}s` };
        }),
        [
          { titulo: 'cenário', valor: (l) => l.id },
          { titulo: 'degrau t=119', valor: (l) => l.antes.preset },
          { titulo: 'reage em', valor: (l) => l.reacao },
          { titulo: 'degrau t=300', valor: (l) => l.depois.preset },
          { titulo: 'Mbps t=300', valor: (l) => emMbps(l.depois.maxBitrate ?? 0) },
          { titulo: 'bpp entregue t=300', valor: (l) => (l.depois.bppMedido ?? 0).toFixed(4) },
          { titulo: 'motivo na tela', valor: (l) => l.depois.motivo ?? 'nenhum' },
        ],
      ),
    );
    console.log();
  }
  if (quedas.length > 0) {
    console.log('═'.repeat(78));
    console.log('QUEDA SUSTENTADA — link cai a 15% entre t=120s e t=150s');
    console.log('═'.repeat(78));
    console.log(
      tabela(
        quedas.map((r) => {
          const antes = r.serie.find((s) => s.t === 119);
          const durante = r.serie.find((s) => s.t === 148);
          const depois = r.serie.at(-1);
          // Recuperação medida em BITRATE, não em bpp: o bpp SOBE quando o
          // degrau cai, então usá-lo declararia recuperação onde houve perda.
          const base = antes.maxBitrate ?? 0;
          const minDurante = Math.min(
            ...r.serie.filter((s) => s.t > 120 && s.t <= 155).map((s) => s.maxBitrate ?? 0),
          );
          const sentiu = minDurante < base * 0.9;
          const volta = r.serie.find((s) => s.t > 150 && (s.maxBitrate ?? 0) >= base * 0.95);
          return {
            id: r.id,
            antes: base,
            durante: durante.maxBitrate ?? 0,
            depois: depois.maxBitrate ?? 0,
            sentiu: sentiu ? 'sim' : 'não',
            recuperou: !sentiu ? '—' : volta === undefined ? 'NUNCA' : `${volta.t - 150}s`,
            presetAntes: antes.preset,
            presetDepois: depois.preset,
            bppDepois: depois.bppPedido ?? 0,
          };
        }),
        [
          { titulo: 'cenário', valor: (l) => l.id },
          { titulo: 'Mbps t=119', valor: (l) => emMbps(l.antes) },
          { titulo: 'Mbps t=148', valor: (l) => emMbps(l.durante) },
          { titulo: 'Mbps t=300', valor: (l) => emMbps(l.depois) },
          { titulo: 'sentiu', valor: (l) => l.sentiu },
          { titulo: 'volta em', valor: (l) => l.recuperou },
          { titulo: 'bpp t=300', valor: (l) => l.bppDepois.toFixed(4) },
          { titulo: 'degrau antes', valor: (l) => l.presetAntes },
          { titulo: 'degrau depois', valor: (l) => l.presetDepois },
        ],
      ),
    );
    console.log();
  }

  console.log(`Resultados completos: ${arquivo}`);
  console.log(PREMISSAS);

  return resultados;
}

function imprimirLista(titulo, lista) {
  console.log('═'.repeat(78));
  console.log(`${titulo}  —  ${lista.length}`);
  console.log('═'.repeat(78));
  if (lista.length === 0) {
    console.log('  (nenhum)\n');
    return;
  }
  console.log(
    tabela(lista.slice(0, 25), [
      { titulo: 'cenário', valor: (r) => r.id },
      { titulo: 'degrau', valor: (r) => r.finalPreset },
      { titulo: 'Mbps', valor: (r) => emMbps(r.finalBitrate) },
      { titulo: 'bpp ped', valor: (r) => r.finalBpp.toFixed(4) },
      { titulo: 'bpp entr', valor: (r) => r.bppEntregue.toFixed(4) },
      { titulo: '%ruim', valor: (r) => r.pctAbaixoPiso.toFixed(0) },
      { titulo: '1ºorc', valor: (r) => (r.tPrimeiroOrcamento === null ? 'NUNCA' : `${r.tPrimeiroOrcamento}s`) },
      { titulo: 'ideal', valor: (r) => `${r.ideal.preset} ${emMbps(r.ideal.bitrate)}Mb` },
      { titulo: 'degraus-', valor: (r) => (r.degrausPerdidos > 0 ? `-${r.degrausPerdidos}` : '0') },
      { titulo: 'bits/ideal', valor: (r) => r.razaoBitrate.toFixed(2) },
      { titulo: 'recfg', valor: (r) => r.reconfigs },
      { titulo: 'estab', valor: (r) => `${r.tEstabiliza}s` },
      { titulo: '%sobre', valor: (r) => r.pctSobreuso.toFixed(0) },
      { titulo: 'mudo', valor: (r) => (r.mudo ? 'SIM' : '') },
      { titulo: 'motivo', valor: (r) => r.motivo ?? '—' },
      { titulo: 'entrou', valor: (r) => `${r.admitidos}/${r.cfg.n}` },
    ]),
  );
  if (lista.length > 25) console.log(`  … e mais ${lista.length - 25}`);
  console.log();

}

function mediana(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function percentil(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/* ═══════════════════════════════════════════════════════════════════════
   PORTÃO DE CI
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Tetos de regressão, com folga sobre o medido em 2026-08-31.
 *
 * Estes números não são metas — são ALARMES. Eles existem porque as malhas de
 * controle não falham de um jeito que teste unitário pegue: elas falham por
 * dinâmica, e a suíte ficou verde em 275 testes enquanto uma regressão deixava
 * as duas malhas mudas ao mesmo tempo (ADR 0019).
 *
 * A folga é de ~25% sobre o medido. Apertar mais transformaria o ruído do
 * simulador em build vermelho, e um portão que grita sem motivo é um portão
 * que alguém desliga.
 *
 * Quando um número aqui subir de propósito, mude o teto NO MESMO COMMIT que
 * muda o comportamento, e diga por quê. Ajustar o teto depois, para o build
 * passar, é o mesmo erro que afrouxar um teste para caber no código.
 */
const TETOS = {
  quadriculado: 90, // medido 70
  mudos: 0, // medido 0 — este não tem folga, é binário
  absorventes: 10, // medido 1
  abaixoDoLink: 175, // medido 138
  afogando: 175, // medido 135
};

export function portao(resultados) {
  const medido = {
    quadriculado: resultados.filter((r) => r.bppEntregue < BPP_PISO || r.pctAbaixoPiso >= 50)
      .length,
    mudos: resultados.filter((r) => r.mudo).length,
    absorventes: resultados.filter((r) => r.absorvente).length,
    abaixoDoLink: resultados.filter((r) => r.degrausPerdidos >= 1 || r.razaoBitrate < 0.8)
      .length,
    afogando: resultados.filter((r) => r.pctSobreuso > 10).length,
  };

  const falhas = Object.entries(TETOS).filter(([k, teto]) => medido[k] > teto);

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('PORTÃO DE CI');
  console.log('══════════════════════════════════════════════════════════════');
  for (const [k, teto] of Object.entries(TETOS)) {
    const v = medido[k];
    console.log(`  ${v > teto ? 'FALHA' : '  ok '}  ${k.padEnd(16)} ${String(v).padStart(4)} / ${teto}`);
  }

  if (falhas.length === 0) {
    console.log('\n  As malhas não regrediram.\n');
    return true;
  }
  console.log(
    `\n  ${falhas.length} métrica(s) de dinâmica pioraram. Se foi de propósito,` +
      '\n  mude o teto NESTE commit e diga por quê — não depois, para o build passar.\n',
  );
  return false;
}

/*
  Sala grande (ADR 0029). Com 50 espectadores num link de 10 Mbps cada um
  recebe 200 kbps: imagem abaixo do piso é FÍSICA, não regressão — a escada
  desce até o fundo e fica, que é o certo. O que não pode acontecer em
  nenhum tamanho de sala é a malha ficar muda, entrar em estado absorvente
  ou afogar o link; é isso que este portão cobra.
*/
const TETOS_ESCALA = {
  mudos: 0,
  absorventes: 0,
  afogando: 0,
  // A porta pela banda (ADR 0030) só pode recusar quem o link NÃO pagava.
  recusadosIndevidos: 0,
};

export function portaoEscala(resultados) {
  const medido = {
    mudos: resultados.filter((r) => r.mudo).length,
    absorventes: resultados.filter((r) => r.absorvente).length,
    /*
      Só conta sala que PASSOU dos cinco que entram antes da 1ª medição
      (`CAPACIDADE_ATE_MEDIR`, o comportamento de antes da ADR 0029). Sala
      de até cinco num link estreito é a matriz normal — onde a malha caça a
      parede do link e o portão de sempre já cobra —, não a sala grande.
    */
    afogando: resultados.filter((r) => r.pctSobreuso > 10 && r.admitidos > 5).length,
    recusadosIndevidos: resultados.filter((r) => r.recusadoIndevido).length,
  };
  console.log('\nPORTÃO DA SALA GRANDE (--escala)');
  let ok = true;
  for (const [k, teto] of Object.entries(TETOS_ESCALA)) {
    const v = medido[k];
    if (v > teto) ok = false;
    console.log(`  ${v > teto ? 'FALHA' : '  ok '}  ${k.padEnd(16)} ${String(v).padStart(4)} / ${teto}`);
  }
  return ok;
}

const resultados = await main();

/*
  Portão de CI. Sem a flag o simulador só REPORTA, que é o uso interativo; com
  ela ele DECIDE, que é o uso no build.
*/
if (flag('portao') && Array.isArray(resultados) && !(ESCALA ? portaoEscala(resultados) : portao(resultados))) {
  process.exitCode = 1;
}
