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

// Chromium do Playwright por padrão; `CHROME=/caminho` usa outro navegador.
const CHROME = process.env.CHROME ?? chromium.executablePath();
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const SLUG = process.env.SLUG ?? 'joao';
// Protocolo v4: o link é só o nome (ADR 0026) e cada espectador pede para
// entrar (ADR 0025).

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

/**
 * `apelido: null` abre sem apelido guardado — é o caminho do formulário. Os
 * demais já chegam com o próprio rótulo como apelido.
 */
async function newPage(label, { apelido = label } = {}) {
  const ctx = await browser.newContext({ permissions: [] });
  if (apelido !== null) {
    await ctx.addInitScript((a) => localStorage.setItem('tela.apelido', a), apelido);
  }
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
// O primeiro <button> do DOM agora pode ser um passo da trilha (quando o slug
// salvo já é válido); o principal é o que diz TRANSMITIR.
const botao = await home.textContent('button:has-text("TRANSMITIR")').catch(() => null);
ok(botao?.includes('TRANSMITIR'), `home mostra o botão principal (${JSON.stringify(botao)})`);
const campo = await home.getAttribute('#slug', 'placeholder').catch(() => null);
ok(campo === 'seunome', 'campo de slug presente');

console.log('\n2. A rota /:slug abre como espectador e fica offline (ninguém transmitindo)');
const viewer = await newPage('viewer');
await viewer.goto(`${WEB}/${SLUG}`, { waitUntil: 'networkidle' });
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
  async ([slug, base]) => {
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
    window.__canvasTrack = track;

    // Áudio de verdade: um oscilador no lugar da trilha do jogo. É o que prova
    // que quem assiste OUVE, e não só vê.
    const audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator();
    osc.frequency.value = 440;
    const dest = audioCtx.createMediaStreamDestination();
    // Só no canal ESQUERDO: é o que permite provar, do outro lado, que o
    // estéreo chegou de verdade e não virou mono (TELA-011).
    const merger = audioCtx.createChannelMerger(2);
    osc.connect(merger, 0, 0);
    merger.connect(dest);
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

    await transport.host(slug, 'o'.repeat(43));
    // Aprovação manual (ADR 0025): o teste decide caso a caso, e liga o aceite
    // automático depois de provar o fluxo.
    window.__pedidos = [];
    window.__autoAceitar = false;
    transport.on('pedido', (p) => {
      window.__pedidos.push(p);
      if (window.__autoAceitar) transport.responderPedido(p.peerId, true);
    });
    await transport.publishVideo(track, shared.PRESET_720P60);
    // Publicado DEPOIS do vídeo, como acontece de verdade — o sink virtual do
    // Linux resolve uns instantes depois da captura de tela.
    await transport.publishAudio(audioTrack);
    void base;
    return { hosted: true, contentHint: track.contentHint, temAudio: Boolean(audioTrack) };
  },
  [SLUG, WEB],
);
ok(resultado.hosted, 'transmissor reivindicou o canal pelo signaling real');
ok(resultado.contentHint === 'motion', 'contentHint=motion aplicado na trilha');
ok(resultado.temAudio, 'trilha de áudio publicada depois do vídeo');

// O espectador já estava na página, em polling. Ele acha a transmissão sozinho
// e PEDE para entrar (ADR 0025): nada de vídeo até o transmissor aceitar.
console.log('   ...esperando o pedido do espectador chegar (polling de 5s)');
let pedido = null;
for (let i = 0; i < 20 && pedido === null; i += 1) {
  await viewer.waitForTimeout(1000);
  pedido = await host.evaluate(() => window.__pedidos.find((p) => p.nome === 'viewer') ?? null);
}
ok(pedido !== null, `transmissor recebeu o pedido com o apelido (${JSON.stringify(pedido)})`);
ok(
  typeof pedido?.impressao === 'string' && pedido.impressao.length === 64,
  'o pedido traz a impressão (sha256) da chave, não a chave',
);
const esperando = await viewer.textContent('body');
ok(esperando.includes('pedido enviado'), `espectador vê que o pedido está com o transmissor (${JSON.stringify(esperando.slice(0, 60))})`);
const semVideoAntes = await viewer.evaluate(() => !document.querySelector('video'));
ok(semVideoAntes, 'antes do aceite, nenhum vídeo');
const naMalhaAntes = await host.evaluate(() => window.__transport.peers().length);
ok(naMalhaAntes === 0, `pedido não ocupa vaga na malha (${naMalhaAntes})`);
await host.evaluate((peerId) => {
  window.__transport.responderPedido(peerId, true);
  window.__autoAceitar = true;
}, pedido?.peerId ?? '');

console.log('   ...esperando o espectador conectar depois do aceite');
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

console.log('\n3a. Estéreo de verdade: o que sai só na esquerda chega só na esquerda (TELA-011)');
{
  const canais = await viewer.evaluate(async () => {
    const video = document.querySelector('video');
    const stream = video?.srcObject;
    if (!(stream instanceof MediaStream) || stream.getAudioTracks().length === 0) return null;
    const ctx = new AudioContext();
    await ctx.resume();
    const origem = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const divisor = ctx.createChannelSplitter(2);
    origem.connect(divisor);
    const medidores = [0, 1].map((i) => {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      divisor.connect(a, i);
      return a;
    });
    const buf = new Float32Array(2048);
    const rms = [0, 0];
    for (let k = 0; k < 20; k += 1) {
      await new Promise((r) => setTimeout(r, 100));
      medidores.forEach((a, i) => {
        a.getFloatTimeDomainData(buf);
        let soma = 0;
        for (const v of buf) soma += v * v;
        rms[i] += Math.sqrt(soma / buf.length) / 20;
      });
    }
    await ctx.close();
    return { esquerda: Number(rms[0].toFixed(4)), direita: Number(rms[1].toFixed(4)) };
  });
  ok(canais !== null, `espectador tem trilha de áudio para medir (${JSON.stringify(canais)})`);
  ok(
    canais !== null && canais.esquerda > 0.05 && canais.direita < canais.esquerda * 0.1,
    'esquerda com sinal, direita quase muda — os dois canais chegaram separados',
  );
}

console.log('\n3a2. Trocar o som sem renegociar: agora só na DIREITA (TELA-012)');
{
  await host.evaluate(async () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 660;
    const merger = ctx.createChannelMerger(2);
    osc.connect(merger, 0, 1);
    const dest = ctx.createMediaStreamDestination();
    merger.connect(dest);
    osc.start();
    await window.__transport.replaceAudio(dest.stream.getAudioTracks()[0]);
  });
  await viewer.waitForTimeout(1500);
  const trocado = await viewer.evaluate(async () => {
    const video = document.querySelector('video');
    const stream = video?.srcObject;
    if (!(stream instanceof MediaStream) || stream.getAudioTracks().length === 0) return null;
    const ctx = new AudioContext();
    await ctx.resume();
    const origem = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const divisor = ctx.createChannelSplitter(2);
    origem.connect(divisor);
    const medidores = [0, 1].map((i) => {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      divisor.connect(a, i);
      return a;
    });
    const buf = new Float32Array(2048);
    const rms = [0, 0];
    for (let k = 0; k < 20; k += 1) {
      await new Promise((r) => setTimeout(r, 100));
      medidores.forEach((a, i) => {
        a.getFloatTimeDomainData(buf);
        let soma = 0;
        for (const v of buf) soma += v * v;
        rms[i] += Math.sqrt(soma / buf.length) / 20;
      });
    }
    await ctx.close();
    return { esquerda: Number(rms[0].toFixed(4)), direita: Number(rms[1].toFixed(4)) };
  });
  ok(
    trocado !== null && trocado.direita > 0.05 && trocado.esquerda < trocado.direita * 0.1,
    `a trilha nova chegou pelo mesmo sender, sem renegociar (${JSON.stringify(trocado)})`,
  );
}

console.log('\n3a3. Pausa de privacidade: o quadro neutro chega no lugar da tela (TELA-022)');
{
  const dims = () => viewer.evaluate(() => {
    const v = document.querySelector('video');
    return v ? `${v.videoWidth}x${v.videoHeight}` : null;
  });
  const antes = await dims();
  await host.evaluate(async () => {
    const { makeCanvasQuadroNeutro } = await import('/src/adapters/canvas-quadro-neutro.ts');
    window.__quadro = makeCanvasQuadroNeutro();
    await window.__transport.replaceVideo(window.__quadro.abrir());
  });
  await viewer.waitForTimeout(4000);
  const pausado = await dims();
  ok(pausado === '480x270' && pausado !== antes, `espectador recebe o quadro neutro, não o último quadro da tela (${antes} → ${pausado})`);
  await host.evaluate(async () => {
    await window.__transport.replaceVideo(window.__canvasTrack);
    window.__quadro.fechar();
  });
  await viewer.waitForTimeout(3000);
  ok((await dims()) === antes, `retomar devolve a tela (${await dims()})`);
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

console.log('\n3c. Link só com o nome (ADR 0026): quem abre pede, e link antigo com #k= também');
{
  await host.evaluate(() => { window.__autoAceitar = false; });
  const soNome = await newPage('so-nome');
  await soNome.goto(`${WEB}/${SLUG}`, { waitUntil: 'domcontentloaded' });
  const antigo = await newPage('link-antigo');
  await antigo.goto(`${WEB}/${SLUG}#k=${'x'.repeat(22)}`, { waitUntil: 'domcontentloaded' });
  await soNome.waitForTimeout(3000);
  const t1 = await soNome.textContent('body');
  ok(t1.includes('pedido enviado'), `link só com o nome chega ao pedido (${JSON.stringify(t1.slice(0, 60))})`);
  const t2 = await antigo.textContent('body');
  ok(t2.includes('pedido enviado'), `link antigo com #k= é aceito e o fragmento ignorado (${JSON.stringify(t2.slice(0, 60))})`);
  const nomes = await host.evaluate(() => window.__pedidos.map((p) => p.nome));
  ok(nomes.includes('so-nome') && nomes.includes('link-antigo'), `os dois pedidos chegaram ao transmissor (${nomes.join(', ')})`);
  const naMalhaAinda = await host.evaluate(() => window.__transport.peers().length);
  ok(naMalhaAinda === 1, `pedido sem resposta não ocupa vaga na malha (${naMalhaAinda})`);
  await soNome.close();
  await antigo.close();
  await host.evaluate(() => { window.__autoAceitar = true; });
}

console.log('\n3d. Aprovação manual: apelido pedido uma vez, e recusa é estado próprio (ADR 0025)');
{
  const novo = await newPage('sem-apelido', { apelido: null });
  await novo.goto(`${WEB}/${SLUG}`, { waitUntil: 'domcontentloaded' });
  await novo.waitForTimeout(1500);
  const form = await novo.textContent('body');
  ok(form.includes('SEU APELIDO'), `sem apelido guardado, pergunta antes de pedir (${JSON.stringify(form.slice(0, 60))})`);
  await host.evaluate(() => { window.__autoAceitar = false; });
  await novo.fill('input', 'ana');
  await novo.click('button:has-text("PEDIR PARA ASSISTIR")');
  let pedidoAna = null;
  for (let i = 0; i < 10 && pedidoAna === null; i += 1) {
    await novo.waitForTimeout(500);
    pedidoAna = await host.evaluate(() => window.__pedidos.find((p) => p.nome === 'ana') ?? null);
  }
  ok(pedidoAna !== null, 'o apelido digitado chega ao transmissor');
  const guardado = await novo.evaluate(() => localStorage.getItem('tela.apelido'));
  ok(guardado === 'ana', 'o apelido fica guardado para a próxima vez');
  await host.evaluate((peerId) => window.__transport.responderPedido(peerId, false), pedidoAna?.peerId ?? '');
  await novo.waitForTimeout(1500);
  const recusado = await novo.textContent('body');
  ok(recusado.includes('pedido recusado'), `recusado vê estado próprio (${JSON.stringify(recusado.slice(0, 60))})`);
  const naMalhaRecusa = await host.evaluate(() => window.__transport.peers().length);
  ok(naMalhaRecusa === 1, `recusado não ocupou vaga (${naMalhaRecusa})`);
  await host.evaluate(() => { window.__autoAceitar = true; });
  await novo.close();
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
  await p.goto(`${WEB}/${SLUG}`, { waitUntil: 'domcontentloaded' });
  extras.push(p);
  await p.waitForTimeout(3000);
}
const naMalha = await host.evaluate(() => window.__transport.peers().length);
ok(naMalha === TETO, `malha cheia com ${naMalha} espectadores (teto ${TETO})`);

const excedente = await newPage('excedente');
await excedente.goto(`${WEB}/${SLUG}`, { waitUntil: 'domcontentloaded' });
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
