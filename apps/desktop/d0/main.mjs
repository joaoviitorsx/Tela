/**
 * Prova técnica D0 (TELA-027) — quanto custa transmitir de dentro do Electron.
 *
 * Não é o app. É a medição que decide se o app, do jeito planejado, cabe no
 * orçamento de docs/desktop/PLANO-desktop.md §1.2, em cada máquina.
 *
 * O que roda: uma janela Electron com a `BroadcastSession` REAL (malhas,
 * transporte mesh, sinalização do `pnpm dev`), alimentada por uma fonte
 * sintética com cara de gameplay — o seletor de tela do Wayland exige clique
 * humano, e a captura real entra num segundo passo com a pessoa presente.
 * Espectadores são outras janelas Electron, escondidas, e ficam FORA da conta:
 * decodificar é custo da máquina de quem assiste, não de quem transmite.
 *
 * O que NÃO mede: impacto no jogo (MangoHud/PresentMon, humano) e o custo da
 * captura de tela de verdade (portal/PipeWire, WGC) — ver o relatório.
 *
 *   pnpm dev                                  (noutro terminal)
 *   pnpm --filter @tela/desktop d0
 *
 * Variáveis: TELA_WEB (padrão http://localhost:5173), TELA_D0_SEGUNDOS (45),
 * TELA_D0_AQUECIMENTO (15), TELA_D0_OUT (pasta do JSON), TELA_D0_CENARIOS
 * (lista separada por vírgula com os nomes abaixo), TELA_FLAGS (valor de
 * --enable-features, ex.: VaapiVideoEncoder).
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';

const WEB = process.env.TELA_WEB ?? 'http://localhost:5173';
const SEGUNDOS = Number(process.env.TELA_D0_SEGUNDOS ?? 45);
/*
  45 s: a estimativa de banda do Chromium sobe ~8%/s a partir de ~300 kbps, e no
  loopback só passa de 15 Mbps depois de uns 40 s. Menos que isso mede a rampa,
  não o encoder no degrau pedido.
*/
const AQUECIMENTO = Number(process.env.TELA_D0_AQUECIMENTO ?? 45);
const FLAGS = process.env.TELA_FLAGS ?? '';

if (FLAGS !== '') app.commandLine.appendSwitch('enable-features', FLAGS);
/**
 * Switches crus do Chromium, `nome=valor` ou `nome`, separados por vírgula.
 * Ex.: `TELA_SWITCHES=ozone-platform=x11,ignore-gpu-blocklist`. É o que separa
 * "GPU desligada no Wayland com NVIDIA" de "GPU funcionando".
 */
const SWITCHES = (process.env.TELA_SWITCHES ?? '').split(',').filter((x) => x !== '');
for (const sw of SWITCHES) {
  const [nome, ...resto] = sw.split('=');
  if (resto.length === 0) app.commandLine.appendSwitch(nome);
  else app.commandLine.appendSwitch(nome, resto.join('='));
}

/**
 * CPU de um processo pelo `/proc`, em NÚCLEOS (1,0 = um núcleo inteiro). Só no
 * Linux; é a régua independente para conferir a escala do `getAppMetrics`.
 */
const TICKS = 100;
function ticksDe(pid) {
  try {
    const campos = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return Number(campos[11]) + Number(campos[12]);
  } catch {
    return null;
  }
}

/** `fonte`: a página desenha a fonte mas não transmite — a linha de base. */
const TODOS = [
  { nome: 'base-fonte', preset: 'p1080p60', espectadores: 0, transmitir: false, oculta: false },
  { nome: '1080p60-1', preset: 'p1080p60', espectadores: 1, transmitir: true, oculta: false },
  { nome: '1080p60-1-oculta', preset: 'p1080p60', espectadores: 1, transmitir: true, oculta: true },
  { nome: '1080p60-3', preset: 'p1080p60', espectadores: 3, transmitir: true, oculta: false },
  { nome: '720p60-1', preset: 'p720p60', espectadores: 1, transmitir: true, oculta: false },
  { nome: '720p60-3', preset: 'p720p60', espectadores: 3, transmitir: true, oculta: false },
  /*
    "Bruto": transporte direto, sem a malha de banda — o encoder fica no degrau
    pedido mesmo quando a estimativa de banda do loopback não chega lá. Mede o
    custo de CODIFICAR 1080p60, que a sessão real só alcança com link folgado.
  */
  { nome: '1080p60-bruto-1', preset: 'p1080p60', espectadores: 1, transmitir: true, oculta: false, bruto: true },
  { nome: '1080p60-bruto-3', preset: 'p1080p60', espectadores: 3, transmitir: true, oculta: false, bruto: true },
];
const ESCOLHIDOS = (process.env.TELA_D0_CENARIOS ?? '').split(',').filter((n) => n !== '');
const CENARIOS = ESCOLHIDOS.length === 0 ? TODOS : TODOS.filter((c) => ESCOLHIDOS.includes(c.nome));

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const PREFERENCIAS = {
  // O que o app de verdade vai usar (ADR 0027): throttling desligado na janela.
  backgroundThrottling: false,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
};

/**
 * Roda DENTRO da página do transmissor. Monta a fonte e, se pedido, a sessão
 * real — mesma composição dos harnesses de banda e qualidade.
 */
async function montarHost({ slug, preset, transmitir, bruto }) {
  /*
    Fonte com cara de jogo: um mundo detalhado desenhado UMA vez, deslocado e
    girado a cada quadro (a câmera), partículas rápidas por cima (efeitos).
    Desenho por `drawImage`, que o canvas acelera na GPU — a fonte tem de ser
    barata para a CPU, senão ela mesma vira o custo medido.
  */
  const W = 1920;
  const H = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const mundo = document.createElement('canvas');
  mundo.width = 3600;
  mundo.height = 2400;
  const m = mundo.getContext('2d', { alpha: false });
  m.fillStyle = '#0d1016';
  m.fillRect(0, 0, 3600, 2400);
  for (let i = 0; i < 4200; i += 1) {
    m.fillStyle = `hsl(${Math.random() * 360} ${40 + Math.random() * 55}% ${12 + Math.random() * 60}%)`;
    const s = 6 + Math.random() * 90;
    m.fillRect(Math.random() * 3600, Math.random() * 2400, s, s * (0.3 + Math.random()));
  }
  const particulas = Array.from({ length: 160 }, () => ({
    x: Math.random() * W, y: Math.random() * H,
    vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40,
    c: `hsl(${Math.random() * 360} 90% 60%)`,
  }));
  let t = 0;
  const quadro = () => {
    t += 1 / 60;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(Math.sin(t * 0.7) * 0.25);
    ctx.drawImage(mundo, -1800 + Math.sin(t) * 700, -1200 + Math.cos(t * 0.8) * 500);
    ctx.restore();
    for (const p of particulas) {
      p.x = (p.x + p.vx + W) % W;
      p.y = (p.y + p.vy + H) % H;
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x, p.y, 10, 10);
    }
  };
  setInterval(quadro, 1000 / 60);
  const video = canvas.captureStream(60).getVideoTracks()[0];
  video.contentHint = 'motion';

  if (!transmitir) {
    window.__d0Stats = () => ({ status: 'fonte' });
    return;
  }

  if (bruto) {
    const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
    const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
    const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
    const shared = await import('/node_modules/@tela/shared/dist/index.js');
    const transport = makeMeshTransport({
      channel: makeWsSignaling(`ws://${location.host}/signal`),
      scheduler: makeBrowserScheduler(),
    });
    await transport.host(slug, `d0${'b'.repeat(41)}`);
    await transport.publishVideo(video, shared.PRESETS[preset]);
    window.__d0Stats = async () => {
      const st = await transport.getAggregateStats();
      return {
        status: 'live', presetId: preset,
        peers: transport.peers().filter((p) => p.connectionState === 'connected').length,
        fps: st?.fps ?? null, bitrateBps: st?.bitrateBps ?? null, width: st?.width ?? null,
        height: st?.height ?? null, bpp: st?.bpp ?? null, qp: st?.qp ?? null,
        msPorQuadro: st?.msPorQuadro ?? null, limitation: st?.limitation ?? null,
        encoder: st?.encoderImplementation ?? null,
      };
    };
    return;
  }

  const { BroadcastSession } = await import('/src/core/media/broadcast-session.ts');
  const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
  const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
  const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
  const { makeBrowserAudioGain } = await import('/src/adapters/browser-audio-gain.ts');
  const scheduler = makeBrowserScheduler();
  const session = new BroadcastSession({
    transport: makeMeshTransport({
      channel: makeWsSignaling(`ws://${location.host}/signal`),
      scheduler,
    }),
    screen: {
      isSupported: () => true,
      request: async () => ({ ok: true, value: { video, audio: null, surface: 'monitor' } }),
    },
    audio: {
      requestPermission: async () => false,
      listMonitors: async () => [],
      capture: async () => {
        throw new Error('sem áudio no D0');
      },
    },
    gain: makeBrowserAudioGain(),
    scheduler,
    shareUrlFor: (s) => `${location.origin}/${s}`,
    createStream: (tracks) => new MediaStream([...tracks]),
    /*
      Link conhecido e folgado (20 Mbps por espectador): o D0 mede o custo de
      codificar no degrau pedido, não a rampa de banda do loopback — que sem
      semente derrubava 1080p para 600p nos primeiros segundos.
    */
    uplinkMemory: { read: () => '20000000', write: () => undefined },
  });
  await session.start(slug, `d0${'k'.repeat(41)}`, { presetId: preset });
  window.__d0Stats = () => {
    const s = session.getState();
    if (s.status !== 'live') return { status: s.status };
    const st = s.stats;
    return {
      status: s.status,
      presetId: s.presetId,
      peers: s.peers.filter((p) => p.connectionState === 'connected').length,
      fps: st?.fps ?? null,
      bitrateBps: st?.bitrateBps ?? null,
      width: st?.width ?? null,
      height: st?.height ?? null,
      bpp: st?.bpp ?? null,
      qp: st?.qp ?? null,
      msPorQuadro: st?.msPorQuadro ?? null,
      limitation: st?.limitation ?? null,
      encoder: st?.encoderImplementation ?? null,
    };
  };
}

function classificar(metricas, hostPid, espectadores) {
  const grupos = { main: [0, 0], host: [0, 0], gpu: [0, 0], utility: [0, 0], outro: [0, 0], espectador: [0, 0] };
  for (const m of metricas) {
    const chave = m.pid === hostPid ? 'host'
      : espectadores.has(m.pid) ? 'espectador'
        : m.type === 'Browser' ? 'main'
          : m.type === 'GPU' ? 'gpu'
            : m.type === 'Utility' ? 'utility' : 'outro';
    grupos[chave][0] += m.cpu.percentCPUUsage;
    grupos[chave][1] += (m.memory?.workingSetSize ?? 0) / 1024;
  }
  return grupos;
}

const media = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const p95 = (xs) => {
  if (xs.length === 0) return null;
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.floor(o.length * 0.95))];
};

async function rodar(c) {
  const host = new BrowserWindow({
    show: !c.oculta, width: 960, height: 540, title: `Tela D0 · ${c.nome}`,
    webPreferences: PREFERENCIAS,
  });
  // Rota leve (a de "não encontrado"): só o módulo da página, sem 3D nem abertura.
  await host.loadURL(`${WEB}/@@d0`);
  if (c.oculta) host.hide();
  const slug = `d0${Math.random().toString(36).slice(2, 8)}`;
  await host.webContents.executeJavaScript(
    `(${montarHost.toString()})(${JSON.stringify({ slug, preset: c.preset, transmitir: c.transmitir, bruto: c.bruto === true })})`,
  );

  const janelas = [];
  for (let i = 0; i < c.espectadores; i += 1) {
    const v = new BrowserWindow({ show: false, webPreferences: PREFERENCIAS });
    v.webContents.setAudioMuted(true);
    await v.loadURL(`${WEB}/${slug}`);
    janelas.push(v);
  }

  await dormir(AQUECIMENTO * 1000);
  const hostPid = host.webContents.getOSProcessId();
  const espectadores = new Set(janelas.map((v) => v.webContents.getOSProcessId()));
  app.getAppMetrics(); // a primeira leitura zera o contador de CPU
  const procInicio = ticksDe(hostPid);
  const tInicio = Date.now();

  const amostras = [];
  for (let s = 0; s < SEGUNDOS; s += 1) {
    await dormir(1000);
    const grupos = classificar(app.getAppMetrics(), hostPid, espectadores);
    const sessao = await host.webContents.executeJavaScript('window.__d0Stats?.() ?? null');
    amostras.push({ grupos, sessao });
  }

  const procFim = ticksDe(hostPid);
  const hostNucleosProc = procInicio === null || procFim === null ? null
    : (procFim - procInicio) / TICKS / ((Date.now() - tInicio) / 1000);
  for (const v of janelas) v.destroy();
  host.destroy();
  await dormir(3000);

  const app_ = amostras.map((a) => a.grupos.main[0] + a.grupos.host[0] + a.grupos.gpu[0] + a.grupos.utility[0] + a.grupos.outro[0]);
  const memoria = amostras.map((a) => a.grupos.main[1] + a.grupos.host[1] + a.grupos.gpu[1] + a.grupos.utility[1] + a.grupos.outro[1]);
  const porGrupo = Object.fromEntries(
    ['main', 'host', 'gpu', 'utility', 'outro', 'espectador'].map((g) => [g, media(amostras.map((a) => a.grupos[g][0]))]),
  );
  const ses = amostras.map((a) => a.sessao).filter((x) => x !== null && x.status === 'live');
  const num = (k) => ses.map((x) => x[k]).filter((v) => typeof v === 'number');
  return {
    ...c,
    cpuAppMedia: media(app_),
    cpuAppP95: p95(app_),
    memoriaAppMB: media(memoria),
    cpuPorGrupo: porGrupo,
    hostNucleosProc,
    sessao: {
      amostrasAoVivo: ses.length,
      conectados: ses.at(-1)?.peers ?? 0,
      presetFinal: ses.at(-1)?.presetId ?? null,
      fps: media(num('fps')),
      mbps: media(num('bitrateBps').map((b) => b / 1e6)),
      largura: ses.at(-1)?.width ?? null,
      altura: ses.at(-1)?.height ?? null,
      bpp: media(num('bpp')),
      qp: media(num('qp')),
      msPorQuadro: media(num('msPorQuadro')),
      limitacoes: [...new Set(ses.map((x) => x.limitation))],
      encoder: [...new Set(ses.map((x) => x.encoder))],
    },
  };
}

app.whenReady().then(async () => {
  const out = process.env.TELA_D0_OUT ?? join(app.getPath('temp'), 'tela-d0');
  mkdirSync(out, { recursive: true });
  /*
    Lê a GPU DEPOIS de existir uma janela desenhando. Sem janela o Chromium nem
    sobe o processo de GPU, e o status volta "disabled_software" em tudo —
    medido aqui: a mesma máquina responde `gpu_compositing: enabled` quatro
    segundos depois de abrir uma janela.
  */
  const aquece = new BrowserWindow({ show: false, webPreferences: PREFERENCIAS });
  await aquece.loadURL('data:text/html,<canvas></canvas>');
  await dormir(4000);
  aquece.destroy();
  const gpu = await app.getGPUInfo('complete');
  const maquina = {
    plataforma: process.platform,
    sistema: release(),
    cpu: cpus()[0]?.model ?? '?',
    nucleos: cpus().length,
    memoriaGB: Math.round(totalmem() / 2 ** 30),
    sessaoGrafica: process.env.XDG_SESSION_TYPE ?? null,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    flags: FLAGS,
    switches: SWITCHES,
    recursosGpu: app.getGPUFeatureStatus(),
    gpus: gpu.gpuDevice ?? null,
    encodeAcelerado: gpu.videoEncodeAcceleratorSupportedProfile ?? null,
    decodeAcelerado: gpu.videoDecodeAcceleratorSupportedProfile ?? null,
  };
  console.log('\n=== Tela D0 — prova técnica ===');
  console.log(JSON.stringify({ ...maquina, gpus: undefined }, null, 1).slice(0, 2000));

  const resultados = [];
  for (const c of CENARIOS) {
    console.log(`\n▶ ${c.nome} (${AQUECIMENTO}s aquecimento + ${SEGUNDOS}s medição)`);
    const r = await rodar(c);
    resultados.push(r);
    const s = r.sessao;
    console.log(
      `  app CPU ${r.cpuAppMedia?.toFixed(2)}% da máquina (p95 ${r.cpuAppP95?.toFixed(2)}) = ` +
        `${((r.cpuAppMedia * maquina.nucleos) / 100).toFixed(2)} núcleo(s) · host pelo /proc ` +
        `${r.hostNucleosProc?.toFixed(2)} núcleo(s) · mem ${r.memoriaAppMB?.toFixed(0)} MB`,
    );
    // `percentCPUUsage` do Electron é % da MÁQUINA (conferido contra /proc).
    console.log(`  por processo (% da máquina): ${Object.entries(r.cpuPorGrupo).map(([g, v]) => `${g} ${v?.toFixed(2)}`).join(' · ')}`);
    if (c.transmitir) {
      console.log(
        `  saída ${s.largura}x${s.altura} ${s.fps?.toFixed(0)}fps ${s.mbps?.toFixed(1)}Mbps bpp ${s.bpp?.toFixed(3)} ` +
          `QP ${s.qp?.toFixed(0)} ${s.msPorQuadro?.toFixed(1)}ms/quadro · ${s.conectados}/${c.espectadores} conectados · ` +
          `limitação ${s.limitacoes.join('/')} · encoder ${s.encoder.join('/')}`,
      );
    }
  }

  const arquivo = join(out, `d0-${process.platform}-${Date.now()}.json`);
  writeFileSync(arquivo, JSON.stringify({ maquina, resultados }, null, 2));
  console.log(`\nresultado: ${arquivo}`);
  app.quit();
});

app.on('window-all-closed', () => undefined);
