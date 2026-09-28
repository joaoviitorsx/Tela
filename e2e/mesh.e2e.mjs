/**
 * Teste de ponta a ponta com DOIS BROWSERS REAIS.
 *
 * Isto é o que os 208 testes unitários não conseguem provar: SDP de verdade,
 * ICE de verdade, encoder de verdade e frames de vídeo de verdade atravessando
 * uma RTCPeerConnection. Os testes com fake garantem a lógica; este garante
 * que a lógica fala com o WebRTC que existe.
 *
 * O que ele NÃO cobre: `getDisplayMedia`. O picker de tela é do sistema
 * operacional e não existe em headless — a captura aqui é um canvas animado.
 * Tudo a jusante da trilha de vídeo é exercitado de verdade.
 */
import { chromium } from 'playwright';

const CHROME = '/home/joaoviitosx/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const SLUG = process.env.SLUG ?? 'joao';
// Protocolo v2 (TELA-018): a sala só abre com o convite do link.
const CONVITE = 'e2e' + 'c'.repeat(19);

const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    // Sem isto o ICE nem tenta candidatos de host em ambiente isolado.
    '--allow-running-insecure-content',
    '--disable-web-security',
  ],
});

/** Página de transmissor: usa o transporte real com um canvas no lugar da tela. */

async function newPage(label) {
  const ctx = await browser.newContext({ permissions: [] });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${label}] console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [${label}] pageerror: ${e.message}`));
  return page;
}

console.log('\n0. Nenhum recurso quebrado na carga inicial');
const scan = await newPage('scan');
const quebrados = [];
scan.on('response', (r) => {
  if (r.status() >= 400) quebrados.push(`${r.status()} ${r.url()}`);
});
await scan.goto(WEB, { waitUntil: 'networkidle' });
await scan.waitForTimeout(500);
ok(quebrados.length === 0, `nenhum 4xx/5xx (${quebrados.join(', ') || 'limpo'})`);

console.log('\n1. O front carrega e a home renderiza');
const home = await newPage('home');
await home.goto(WEB, { waitUntil: 'networkidle' });
const botao = await home.textContent('button').catch(() => null);
ok(botao?.includes('TRANSMITIR'), `home mostra o botão principal (${JSON.stringify(botao)})`);
const campo = await home.getAttribute('#slug', 'placeholder').catch(() => null);
ok(campo === 'seunome', 'campo de slug presente');

console.log('\n2. A rota /:slug abre como espectador e fica offline (ninguém transmitindo)');
const viewer = await newPage('viewer');
await viewer.goto(`${WEB}/${SLUG}#k=${CONVITE}`, { waitUntil: 'networkidle' });
await viewer.waitForTimeout(2500);
const texto = await viewer.textContent('body');
ok(
  texto.includes('aguardando sinal') || texto.includes('conectando'),
  `espectador vê estado offline, não erro (${JSON.stringify(texto.slice(0, 60))})`,
);

console.log('\n3. Mesh real: host publica canvas, espectador recebe frames');
const host = await newPage('host');
await host.goto(`${WEB}/`, { waitUntil: 'networkidle' });

const resultado = await host.evaluate(
  async ([slug, base, convite]) => {
    const { makeMeshTransport } = await import('/src/adapters/mesh-transport.ts');
    const { makeWsSignaling } = await import('/src/adapters/ws-signaling.ts');
    const { makeBrowserScheduler } = await import('/src/adapters/browser-scheduler.ts');
    const shared = await import('/node_modules/@tela/shared/dist/index.js');

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    let frame = 0;
    setInterval(() => {
      frame += 1;
      ctx.fillStyle = `hsl(${frame % 360} 90% 50%)`;
      ctx.fillRect(0, 0, 640, 360);
    }, 33);

    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'motion';

    // Áudio de verdade: um oscilador no lugar da trilha do jogo. É o que prova
    // que quem assiste OUVE, e não só vê.
    const audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator();
    osc.frequency.value = 440;
    const dest = audioCtx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const audioTrack = dest.stream.getAudioTracks()[0];

    const transport = makeMeshTransport({
      channel: makeWsSignaling(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`,
      ),
      // Obrigatório desde a TELA-005: é quem agenda a renovação do ICE.
      scheduler: makeBrowserScheduler(),
    });
    window.__transport = transport;

    await transport.host(slug, 'o'.repeat(43), convite);
    await transport.publishVideo(track, shared.PRESET_720P60);
    // Publicado DEPOIS do vídeo, como acontece de verdade — o sink virtual do
    // Linux resolve uns instantes depois da captura de tela.
    await transport.publishAudio(audioTrack);
    void base;
    return { hosted: true, contentHint: track.contentHint, temAudio: Boolean(audioTrack) };
  },
  [SLUG, WEB, CONVITE],
);
ok(resultado.hosted, 'transmissor reivindicou o canal pelo signaling real');
ok(resultado.contentHint === 'motion', 'contentHint=motion aplicado na trilha');
ok(resultado.temAudio, 'trilha de áudio publicada depois do vídeo');

// O espectador já estava na página, em polling. Ele deve conectar sozinho.
console.log('   ...esperando o espectador conectar sozinho (polling de 5s)');
let conectou = false;
for (let i = 0; i < 20; i += 1) {
  await viewer.waitForTimeout(1000);
  const temVideo = await viewer.evaluate(() => {
    const v = document.querySelector('video');
    return Boolean(v && v.srcObject && v.videoWidth > 0);
  });
  if (temVideo) {
    conectou = true;
    break;
  }
}
ok(conectou, 'espectador conectou SOZINHO e está recebendo frames de vídeo');

if (conectou) {
  const stats = await viewer.evaluate(async () => {
    const v = document.querySelector('video');
    return { w: v.videoWidth, h: v.videoHeight, tocando: !v.paused };
  });
  ok(stats.w > 0 && stats.h > 0, `vídeo tem dimensões reais (${stats.w}x${stats.h})`);
  ok(stats.tocando, 'vídeo está tocando');

  const peers = await host.evaluate(() => window.__transport.peers().length);
  ok(peers === 1, `transmissor enxerga ${peers} espectador na malha`);

  // Duas leituras: a primeira não tem delta para derivar bitrate. Se a
  // segunda também vier zerada, os frames não estão realmente saindo.
  const agregado = await host.evaluate(async () => {
    await window.__transport.getAggregateStats();
    await new Promise((r) => setTimeout(r, 2000));
    return await window.__transport.getAggregateStats();
  });
  ok(agregado !== null, `estatísticas agregadas: ${JSON.stringify(agregado)}`);
  ok(agregado?.bitrateBps > 0, `bitrate real medido: ${agregado?.bitrateBps} bps`);
  ok(agregado?.fps > 0, `framerate real medido: ${agregado?.fps} fps`);

  console.log('\n   Áudio: quem assiste precisa OUVIR o gameplay');
  let comAudio = null;
  for (let i = 0; i < 15; i += 1) {
    comAudio = await viewer.evaluate(() => {
      const v = document.querySelector('video');
      const s = v?.srcObject;
      if (!s) return null;
      const a = s.getAudioTracks();
      return {
        trilhas: a.length,
        viva: a[0]?.readyState === 'live',
        // O overlay só aparece se a sessão soube que existe áudio.
        overlay: Boolean([...document.querySelectorAll('button')].find((b) =>
          b.textContent?.includes('ativar o som'),
        )),
      };
    });
    if (comAudio?.trilhas > 0) break;
    await viewer.waitForTimeout(1000);
  }
  ok(comAudio?.trilhas > 0, `espectador recebeu trilha de áudio (${JSON.stringify(comAudio)})`);
  ok(comAudio?.viva, 'trilha de áudio está viva no espectador');
  ok(
    comAudio?.overlay,
    'overlay "clique para ativar o som" apareceu — sem ele o espectador fica mudo sem saber',
  );

  /*
    TELA-007: o áudio medido à parte, contra o `getStats()` que existe. Os
    testes unitários provam a conta; só um Chrome de verdade prova que os
    nomes de campo (`media-source`, `totalAudioEnergy`, `codecId`) são os que
    o navegador reporta. Duas leituras, porque taxa exige delta.
  */
  const audioEnvio = await host.evaluate(async () => {
    await window.__transport.getAggregateStats();
    await new Promise((r) => setTimeout(r, 1500));
    const s = await window.__transport.getAggregateStats();
    return s?.audio ?? null;
  });
  ok(audioEnvio !== null, `transmissor mede o áudio à parte do vídeo (${JSON.stringify(audioEnvio)})`);
  ok((audioEnvio?.bitrateBps ?? 0) > 0, 'taxa de áudio de envio medida por delta');
  ok((audioEnvio?.nivel ?? 0) > 0.01, 'nível do oscilador medido na media-source — a fonte não está muda');
  ok(audioEnvio?.codec?.mimeType === 'audio/opus', 'codec de áudio negociado lido do relatório');
  // TELA-008: o teto só é afirmado quando o sender aceitou e ele foi lido de volta.
  ok(
    audioEnvio?.configuracao?.aplicados === 1 && audioEnvio?.configuracao?.maxBitrate === 128000,
    `sender de áudio aceitou 128 kbps (${JSON.stringify(audioEnvio?.configuracao)})`,
  );

  console.log('\n   Troca de qualidade ao vivo NÃO pode derrubar quem assiste');
  await host.evaluate(async () => {
    const shared = await import('/node_modules/@tela/shared/dist/index.js');
    // O `_ECO` saiu com a recalibração da escada (ADR 0010); o degrau abaixo serve.
    await window.__transport.setPreset(shared.PRESET_480P60);
  });
  await viewer.waitForTimeout(2000);
  const aindaAssistindo = await viewer.evaluate(() => {
    const v = document.querySelector('video');
    return Boolean(v && v.srcObject && v.videoWidth > 0 && !v.paused);
  });
  ok(aindaAssistindo, 'espectador continuou assistindo depois da troca de preset');
}

console.log('\n3b. Grafo de ganho em Chrome real (TELA-009)');
{
  const grafo = await host.evaluate(async () => {
    const { makeBrowserAudioGain } = await import('/src/adapters/browser-audio-gain.ts');
    const fonte = () => {
      const c = new AudioContext();
      const d = c.createMediaStreamDestination();
      c.createOscillator().connect(d);
      return d.stream.getAudioTracks()[0];
    };
    const g = makeBrowserAudioGain();
    const estados = [];
    g.onEstado((e) => estados.push(e));
    const saida = g.attach(fonte());
    await new Promise((r) => setTimeout(r, 300));
    const inicial = g.estado;
    // Religar fecha o anterior: um grafo por vez.
    const primeiraSaida = saida;
    g.attach(fonte());
    const anteriorParou = primeiraSaida.readyState === 'ended';
    g.close();
    const fechado = g.estado;

    // Fallback sem Web Audio: o mudo continua valendo na trilha crua.
    const original = window.AudioContext;
    const crua = fonte();
    window.AudioContext = undefined;
    const f = makeBrowserAudioGain();
    const devolvida = f.attach(crua);
    f.set(0);
    const mudoNoFallback = devolvida === crua && crua.enabled === false;
    f.set(0.5);
    const voltou = crua.enabled === true;
    window.AudioContext = original;
    return { inicial, anteriorParou, fechado, estados, mudoNoFallback, voltou, ativoFallback: f.ativo };
  });
  ok(grafo.inicial === 'ativo', `grafo nasce ativo dentro da página (${JSON.stringify(grafo)})`);
  ok(grafo.anteriorParou, 'religar o grafo para a saída do anterior');
  ok(grafo.fechado === 'indisponivel', 'fechar deixa o grafo indisponível');
  ok(grafo.mudoNoFallback && grafo.voltou && !grafo.ativoFallback, 'sem Web Audio, o mudo desliga a trilha crua');
}

console.log('\n3c. Sala privada: link sem convite ou com convite errado não entra (TELA-018)');
{
  const semConvite = await newPage('sem-convite');
  await semConvite.goto(`${WEB}/${SLUG}`, { waitUntil: 'domcontentloaded' });
  await semConvite.waitForTimeout(1500);
  const t1 = await semConvite.textContent('body');
  ok(t1.includes('link incompleto'), `link sem #k= nem tenta entrar (${JSON.stringify(t1.slice(0, 60))})`);

  const errado = await newPage('convite-errado');
  await errado.goto(`${WEB}/${SLUG}#k=${'x'.repeat(22)}`, { waitUntil: 'domcontentloaded' });
  await errado.waitForTimeout(3000);
  const t2 = await errado.textContent('body');
  ok(t2.includes('convite renovado'), `convite errado é recusado pelo servidor (${JSON.stringify(t2.slice(0, 60))})`);
  const naMalhaAinda = await host.evaluate(() => window.__transport.peers().length);
  ok(naMalhaAinda === 1, `recusado não ocupou vaga na malha (${naMalhaAinda})`);
  await semConvite.close();
  await errado.close();
}

console.log('\n4. Teto de espectadores é aplicado de verdade');
/**
 * Um espectador já está assistindo; os outros enchem o canal.
 *
 * Este teste já mentiu uma vez: quando o limite subiu de 3 para 5, ele
 * continuou enchendo o canal com 4 espectadores e o "canal cheio" nunca
 * enchia. O número abaixo PRECISA acompanhar `P2P_LIMITS.maxViewersBrowser`
 * em `packages/shared/src/encoding.ts` — o e2e roda contra o bundle, sem
 * import, então não dá para derivar daqui.
 */
const TETO = 5;
const extras = [];
for (let i = 0; i < TETO - 1; i += 1) {
  const p = await newPage(`extra${i}`);
  await p.goto(`${WEB}/${SLUG}#k=${CONVITE}`, { waitUntil: 'domcontentloaded' });
  extras.push(p);
  await p.waitForTimeout(3000);
}
const naMalha = await host.evaluate(() => window.__transport.peers().length);
ok(naMalha === TETO, `malha cheia com ${naMalha} espectadores (teto ${TETO})`);

const excedente = await newPage('excedente');
await excedente.goto(`${WEB}/${SLUG}#k=${CONVITE}`, { waitUntil: 'domcontentloaded' });
await excedente.waitForTimeout(4000);
const textoCheio = await excedente.textContent('body');
ok(
  textoCheio.includes('sem vaga'),
  `espectador excedente vê "sem vaga", estado próprio e não erro cru (${JSON.stringify(textoCheio.slice(0, 70))})`,
);

console.log('\n5. Transmissor sai: espectadores voltam para offline e seguem tentando');
await host.evaluate(async () => {
  await window.__transport.disconnect();
});
await viewer.waitForTimeout(4000);
const depoisDaQueda = await viewer.textContent('body');
ok(
  depoisDaQueda.includes('aguardando sinal') || depoisDaQueda.includes('conectando'),
  'espectador voltou ao estado offline em vez de travar',
);

await browser.close();
console.log(process.exitCode ? '\n=== E2E FALHOU ===' : '\n=== E2E PASSOU ===');
