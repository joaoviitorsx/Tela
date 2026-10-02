/**
 * Estudo de desempenho (docs/engenharia/estudo-desempenho.md, §1): o que o
 * Chromium desta máquina DIZ que codifica e decodifica, antes de qualquer
 * promessa sobre HEVC, AV1, SVC temporal ou quantizador.
 *
 * Sonda `VideoEncoder.isConfigSupported` × codec × aceleração × `scalabilityMode`
 * × `bitrateMode`, `VideoDecoder.isConfigSupported`, `MediaCapabilities`
 * (tipo `webrtc`) e `RTCRtpSender/Receiver.getCapabilities('video')`, mais a
 * presença das APIs de que o "um encode, N envios" e a cascata dependem.
 *
 * Dois navegadores, nenhuma janela visível:
 *
 *   pnpm dev                                                 (noutro terminal)
 *   node e2e/bench/estudo-webcodecs-matriz.mjs               # Chromium headless do Playwright (sem GPU)
 *   pnpm --filter @tela/desktop exec electron ../../e2e/bench/estudo-webcodecs-matriz.mjs
 *                                                            # Electron do app, janela escondida, GPU real
 *
 * `--json` imprime uma linha JSON por resultado; `--flags=A,B` liga features
 * do Chromium (ex.: `VaapiVideoEncoder,VaapiVideoDecodeLinuxGL`).
 */
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const JSON_SAIDA = args['json'] === true;
const FLAGS = typeof args['flags'] === 'string' ? args['flags'] : '';

/** Roda DENTRO da página. Tudo o que devolve é serializável. */
async function sonda() {
  const codecs = [
    ['H.264 CBP 4.2', 'avc1.42e02a'],
    ['H.264 Main 4.2', 'avc1.4d002a'],
    ['H.264 High 4.2', 'avc1.64002a'],
    ['H.264 High 5.1', 'avc1.640033'],
    ['HEVC Main 4.1', 'hvc1.1.6.L123.B0'],
    ['HEVC Main 5.1', 'hvc1.1.6.L153.B0'],
    ['AV1 Main 4.0', 'av01.0.08M.08'],
    ['AV1 Main 5.1', 'av01.0.13M.08'],
    ['VP9 p0 4.1', 'vp09.00.41.08'],
    ['VP8', 'vp8'],
  ];
  const aceleracoes = ['no-preference', 'prefer-hardware', 'prefer-software'];
  const svc = [undefined, 'L1T1', 'L1T2', 'L1T3'];
  const bitrateModes = ['variable', 'constant', 'quantizer'];
  const base = { width: 1920, height: 1080, framerate: 60, bitrate: 12_000_000, latencyMode: 'realtime' };

  const encode = [];
  if (typeof VideoEncoder !== 'undefined') {
    for (const [nome, codec] of codecs) {
      for (const hw of aceleracoes) {
        for (const modo of svc) {
          const cfg = { ...base, codec, hardwareAcceleration: hw, bitrateMode: 'variable' };
          if (modo !== undefined) cfg.scalabilityMode = modo;
          if (codec.startsWith('avc1')) cfg.avc = { format: 'annexb' };
          if (codec.startsWith('hvc1')) cfg.hevc = { format: 'annexb' };
          let suportado = null;
          let erro = null;
          try {
            suportado = (await VideoEncoder.isConfigSupported(cfg)).supported === true;
          } catch (e) {
            erro = String(e?.name ?? e);
          }
          encode.push({ nome, codec, hw, svc: modo ?? '-', suportado, erro });
        }
      }
      // bitrateMode, só na aceleração padrão e sem SVC
      for (const bm of bitrateModes) {
        const cfg = { ...base, codec, hardwareAcceleration: 'no-preference', bitrateMode: bm };
        if (codec.startsWith('avc1')) cfg.avc = { format: 'annexb' };
        if (codec.startsWith('hvc1')) cfg.hevc = { format: 'annexb' };
        let suportado = null;
        let erro = null;
        try {
          suportado = (await VideoEncoder.isConfigSupported(cfg)).supported === true;
        } catch (e) {
          erro = String(e?.name ?? e);
        }
        encode.push({ nome, codec, hw: 'no-preference', svc: '-', bitrateMode: bm, suportado, erro });
      }
    }
  }

  // contentHint no VideoEncoderConfig (spec recente): aceito ou ignorado?
  let contentHint = null;
  if (typeof VideoEncoder !== 'undefined') {
    try {
      const r = await VideoEncoder.isConfigSupported({ ...base, codec: 'avc1.42e02a', contentHint: 'motion' });
      contentHint = { supported: r.supported, ecoado: 'contentHint' in (r.config ?? {}) };
    } catch (e) {
      contentHint = { erro: String(e?.name ?? e) };
    }
  }

  const decode = [];
  if (typeof VideoDecoder !== 'undefined') {
    for (const [nome, codec] of codecs) {
      for (const hw of aceleracoes) {
        let suportado = null;
        let erro = null;
        try {
          suportado = (await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080, hardwareAcceleration: hw })).supported === true;
        } catch (e) {
          erro = String(e?.name ?? e);
        }
        decode.push({ nome, codec, hw, suportado, erro });
      }
    }
  }

  const mc = [];
  const tiposRtc = [
    ['H264 42e01f', 'video/H264;profile-level-id=42e01f;packetization-mode=1'],
    ['H264 4d001f', 'video/H264;profile-level-id=4d001f;packetization-mode=1'],
    ['H264 640c1f', 'video/H264;profile-level-id=640c1f;packetization-mode=1'],
    ['H265', 'video/H265'],
    ['AV1', 'video/AV1'],
    ['VP9', 'video/VP9'],
    ['VP8', 'video/VP8'],
  ];
  if (navigator.mediaCapabilities) {
    for (const [nome, contentType] of tiposRtc) {
      for (const sentido of ['encodingInfo', 'decodingInfo']) {
        try {
          const r = await navigator.mediaCapabilities[sentido]({
            type: 'webrtc',
            video: { contentType, width: 1920, height: 1080, bitrate: 12_000_000, framerate: 60 },
          });
          mc.push({ nome, sentido, supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient });
        } catch (e) {
          mc.push({ nome, sentido, erro: String(e?.name ?? e) });
        }
      }
    }
  }

  const caps = (lado) => {
    try {
      const c = lado.getCapabilities('video');
      return (c?.codecs ?? [])
        .filter((x) => !/rtx|red|ulpfec|flexfec/i.test(x.mimeType))
        .map((x) => ({ mimeType: x.mimeType, fmtp: x.sdpFmtpLine ?? '', svc: x.scalabilityModes ?? [] }));
    } catch (e) {
      return [{ erro: String(e) }];
    }
  };
  const fec = (lado) => {
    try {
      return (lado.getCapabilities('video')?.codecs ?? []).map((x) => x.mimeType).filter((m) => /rtx|red|ulpfec|flexfec/i.test(m));
    } catch {
      return [];
    }
  };
  const apis = {
    VideoEncoder: typeof VideoEncoder !== 'undefined',
    VideoDecoder: typeof VideoDecoder !== 'undefined',
    MediaStreamTrackProcessor: typeof MediaStreamTrackProcessor !== 'undefined',
    MediaStreamTrackGenerator: typeof MediaStreamTrackGenerator !== 'undefined',
    VideoTrackGenerator: typeof VideoTrackGenerator !== 'undefined',
    RTCRtpScriptTransform: typeof RTCRtpScriptTransform !== 'undefined',
    'RTCEncodedVideoFrame.setMetadata': typeof RTCEncodedVideoFrame !== 'undefined' && typeof RTCEncodedVideoFrame.prototype.setMetadata === 'function',
    'RTCEncodedVideoFrame(frame, options)': (() => {
      try {
        return typeof RTCEncodedVideoFrame !== 'undefined' && RTCEncodedVideoFrame.length >= 0 && 'constructor' in RTCEncodedVideoFrame.prototype;
      } catch {
        return false;
      }
    })(),
    'RTCRtpSender.createEncodedSource': typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.prototype.createEncodedSource === 'function',
    'RTCRtpScriptTransform.generateKeyFrame': typeof RTCRtpScriptTransformer !== 'undefined' && typeof RTCRtpScriptTransformer.prototype.generateKeyFrame === 'function',
    'RTCRtpReceiver.jitterBufferTarget': typeof RTCRtpReceiver !== 'undefined' && 'jitterBufferTarget' in RTCRtpReceiver.prototype,
    'RTCRtpReceiver.playoutDelayHint': typeof RTCRtpReceiver !== 'undefined' && 'playoutDelayHint' in RTCRtpReceiver.prototype,
    'HTMLVideoElement.requestVideoFrameCallback': 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    'RTCRtpSender.setParameters': typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.prototype.setParameters === 'function',
    'RTCRtpEncodingParameters.scalabilityMode (sender caps)': (() => {
      try {
        return (RTCRtpSender.getCapabilities('video')?.codecs ?? []).some((c) => Array.isArray(c.scalabilityModes) && c.scalabilityModes.length > 0);
      } catch {
        return false;
      }
    })(),
    'navigator.gpu': 'gpu' in navigator,
  };
  // Extensões de cabeçalho RTP (abs-capture-time é o que fecha a latência no espectador)
  let headerExtensions = [];
  try {
    headerExtensions = (RTCRtpSender.getCapabilities('video')?.headerExtensions ?? []).map((h) => h.uri);
  } catch {
    headerExtensions = [];
  }
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    apis,
    encode,
    contentHint,
    decode,
    mediaCapabilities: mc,
    senderCodecs: caps(RTCRtpSender),
    receiverCodecs: caps(RTCRtpReceiver),
    fec: { sender: fec(RTCRtpSender), receiver: fec(RTCRtpReceiver) },
    headerExtensions,
  };
}

function imprimir(r, rotulo) {
  if (JSON_SAIDA) {
    console.log(JSON.stringify({ rotulo, ...r }));
    return;
  }
  console.log(`\n== ${rotulo} ==\n${r.userAgent}\n`);
  console.log('APIs:');
  for (const [k, v] of Object.entries(r.apis)) console.log(`  ${v ? 'sim' : 'NÃO'}  ${k}`);
  console.log(`\nVideoEncoderConfig.contentHint: ${JSON.stringify(r.contentHint)}`);

  console.log('\nVideoEncoder.isConfigSupported (1920×1080@60, 12 Mbps, realtime) — linhas: codec; colunas: aceleração × SVC');
  const chave = (e) => `${e.hw}/${e.svc}`;
  const colunas = [];
  for (const hw of ['no-preference', 'prefer-hardware', 'prefer-software']) for (const s of ['-', 'L1T1', 'L1T2', 'L1T3']) colunas.push(`${hw}/${s}`);
  console.log(`  ${'codec'.padEnd(16)} ${colunas.map((c) => c.replace('no-preference', 'np').replace('prefer-hardware', 'hw').replace('prefer-software', 'sw').padEnd(8)).join('')}`);
  const porCodec = new Map();
  for (const e of r.encode) {
    if (e.bitrateMode !== undefined) continue;
    if (!porCodec.has(e.nome)) porCodec.set(e.nome, new Map());
    porCodec.get(e.nome).set(chave(e), e);
  }
  for (const [nome, m] of porCodec) {
    const celulas = colunas.map((c) => {
      const e = m.get(c);
      if (e === undefined) return '?';
      if (e.erro) return 'erro';
      return e.suportado ? 'sim' : 'não';
    });
    console.log(`  ${nome.padEnd(16)} ${celulas.map((x) => x.padEnd(8)).join('')}`);
  }
  console.log('\n  bitrateMode (no-preference):');
  for (const [nome] of porCodec) {
    const bms = r.encode.filter((e) => e.nome === nome && e.bitrateMode !== undefined);
    console.log(`  ${nome.padEnd(16)} ${bms.map((e) => `${e.bitrateMode}=${e.erro ? 'erro' : e.suportado ? 'sim' : 'não'}`).join('  ')}`);
  }

  console.log('\nVideoDecoder.isConfigSupported (1920×1080):');
  const dec = new Map();
  for (const d of r.decode) {
    if (!dec.has(d.nome)) dec.set(d.nome, []);
    dec.get(d.nome).push(`${d.hw.replace('no-preference', 'np').replace('prefer-hardware', 'hw').replace('prefer-software', 'sw')}=${d.erro ? 'erro' : d.suportado ? 'sim' : 'não'}`);
  }
  for (const [nome, xs] of dec) console.log(`  ${nome.padEnd(16)} ${xs.join('  ')}`);

  console.log('\nMediaCapabilities (type: webrtc, 1080p60 12 Mbps):');
  for (const m of r.mediaCapabilities) {
    console.log(`  ${m.nome.padEnd(12)} ${m.sentido.padEnd(13)} ${m.erro ? `erro ${m.erro}` : `supported=${m.supported} smooth=${m.smooth} powerEfficient=${m.powerEfficient}`}`);
  }

  console.log('\nRTCRtpSender.getCapabilities(video):');
  for (const c of r.senderCodecs) console.log(`  ${c.mimeType.padEnd(12)} ${c.fmtp.padEnd(60)} svc=${(c.svc ?? []).join(',') || '-'}`);
  console.log('RTCRtpReceiver.getCapabilities(video):');
  for (const c of r.receiverCodecs) console.log(`  ${c.mimeType.padEnd(12)} ${c.fmtp.padEnd(60)} svc=${(c.svc ?? []).join(',') || '-'}`);
  console.log(`FEC/RTX: sender ${r.fec.sender.join(', ')} | receiver ${r.fec.receiver.join(', ')}`);
  console.log(`Extensões RTP (sender): ${r.headerExtensions.join(' ')}`);
}

async function viaPlaywright() {
  const { chromium } = await import('playwright');
  const argsChromium = [];
  if (FLAGS !== '') argsChromium.push(`--enable-features=${FLAGS}`, '--ignore-gpu-blocklist');
  const browser = await chromium.launch({ headless: true, args: argsChromium });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${WEB}/@@bench`, { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(sonda);
    imprimir(r, `Chromium headless (Playwright)${FLAGS !== '' ? ` --enable-features=${FLAGS}` : ''}`);
  } finally {
    await browser.close();
  }
}

async function viaElectron() {
  const { app, BrowserWindow } = await import('electron');
  if (FLAGS !== '') app.commandLine.appendSwitch('enable-features', FLAGS);
  await app.whenReady();
  const janela = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, enableBlinkFeatures: 'RTCEncodedFrameSetMetadata' },
  });
  try {
    await janela.loadURL(`${WEB}/@@bench`);
    const r = await janela.webContents.executeJavaScript(`(${sonda.toString()})()`);
    const gpu = await app.getGPUInfo('basic').catch(() => null);
    imprimir({ ...r, gpu }, `Electron ${process.versions.electron} (Chrome ${process.versions.chrome}), janela escondida${FLAGS !== '' ? ` --enable-features=${FLAGS}` : ''}`);
    if (!JSON_SAIDA && gpu?.gpuDevice) console.log(`GPU: ${JSON.stringify(gpu.gpuDevice.map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active })))}`);
    if (!JSON_SAIDA && gpu?.auxAttributes) {
      const a = gpu.auxAttributes;
      console.log(`GL: ${a.glRenderer ?? '?'} · driver ${a.driverVersion ?? '?'} · video encode accel: ${a.videoEncodeAcceleratorSupportedProfiles === undefined ? 'n/d' : 'ver JSON'}`);
    }
  } finally {
    janela.destroy();
    app.quit();
  }
}

if (process.versions.electron !== undefined) {
  await viaElectron();
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await viaPlaywright();
}
