/**
 * Homologação de conectividade em Chromium real, sem captura de tela.
 * Obtém credenciais efêmeras do signaling e testa cada URL TURN isoladamente.
 * Nenhum segredo, IP, candidato ou SDP entra no relatório.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const modes = (process.env.MODES ?? 'direct').split(',').map((value) => value.trim());
const allowed = new Set(['direct', 'udp', 'tcp', 'tls']);
if (modes.length === 0 || modes.some((mode) => !allowed.has(mode))) {
  throw new Error('MODES deve conter direct,udp,tcp,tls separados por vírgula');
}

const timeout = (ms, code) => new Promise((_, reject) => setTimeout(() => reject(new Error(code)), ms));
const slug = `relay${randomBytes(8).toString('hex')}`;

async function credentials() {
  const base = process.env.SIGNAL_URL;
  if (!base) throw new Error('SIGNAL_URL_REQUIRED');
  const socket = new WebSocket(`${base.replace(/\/+$/, '')}/${slug}`);
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        socket.addEventListener('open', () => socket.send(JSON.stringify({
          type: 'host', slug, ownerToken: randomBytes(32).toString('base64url'),
        })));
        socket.addEventListener('message', (event) => {
          let message;
          try { message = JSON.parse(String(event.data)); }
          catch { reject(new Error('SIGNAL_INVALID')); return; }
          if (message.type === 'hosting') {
            if (message.relayStatus !== 'available') reject(new Error('RELAY_UNAVAILABLE'));
            else resolve(message.iceServers);
          } else if (message.type === 'error') reject(new Error('SIGNAL_REJECTED'));
        });
        socket.addEventListener('error', () => reject(new Error('SIGNAL_UNREACHABLE')));
        socket.addEventListener('close', () => reject(new Error('SIGNAL_CLOSED')));
      }),
      timeout(8_000, 'SIGNAL_TIMEOUT'),
    ]);
  } finally {
    socket.close();
  }
}

function urlsFor(servers, mode) {
  if (mode === 'direct') return [];
  const chosen = [];
  for (const server of servers) {
    for (const url of [server.urls].flat()) {
      const lower = url.toLowerCase();
      const matches = mode === 'tls'
        ? lower.startsWith('turns:')
        : mode === 'tcp'
          ? lower.startsWith('turn:') && lower.includes('transport=tcp')
          : lower.startsWith('turn:') && (lower.includes('transport=udp') || !lower.includes('transport='));
      if (matches) chosen.push({ urls: url, username: server.username, credential: server.credential });
    }
  }
  return chosen;
}

/** Exposto só dentro da página de teste; usa a API real do browser. */
async function createPeer(page, iceServers, policy, sender) {
  await page.goto('about:blank');
  await page.evaluate(({ iceServers: servers, policy: icePolicy, sender: sends }) => {
    const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: icePolicy });
    window.__relayPc = pc;
    if (sends) {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d');
      let frame = 0;
      window.__relayTimer = setInterval(() => {
        context.fillStyle = `hsl(${frame++ % 360} 80% 50%)`;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 33);
      const stream = canvas.captureStream(30);
      pc.addTrack(stream.getVideoTracks()[0], stream);
    } else {
      pc.ontrack = ({ streams }) => {
        const video = document.createElement('video');
        video.muted = true;
        video.autoplay = true;
        video.srcObject = streams[0];
        document.body.append(video);
        void video.play();
      };
    }
  }, { iceServers, policy, sender });
}

async function description(page, remote) {
  return page.evaluate(async (other) => {
    const pc = window.__relayPc;
    if (other) await pc.setRemoteDescription(other);
    if (!other) await pc.setLocalDescription(await pc.createOffer());
    else await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== 'complete') {
      await Promise.race([
        new Promise((resolve) => pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') resolve();
        })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('GATHER_TIMEOUT')), 25_000)),
      ]);
    }
    return { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
  }, remote);
}

async function sample(page) {
  return page.evaluate(async () => {
    const pc = window.__relayPc;
    const report = await pc.getStats();
    const entries = [...report.values()];
    const byId = new Map(entries.map((stat) => [stat.id, stat]));
    const transport = entries.find((stat) => stat.type === 'transport' && stat.selectedCandidatePairId);
    let pair = transport ? byId.get(transport.selectedCandidatePairId) : null;
    let source = 'transport';
    if (!transport) {
      const selected = entries.filter((stat) => stat.type === 'candidate-pair' && stat.selected === true);
      const nominated = entries.filter((stat) => stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded');
      pair = selected.length === 1 ? selected[0] : selected.length === 0 && nominated.length === 1 ? nominated[0] : null;
      source = selected.length === 1 ? 'legacy-selected' : 'unique-nominated';
    }
    const local = byId.get(pair?.localCandidateId);
    const remote = byId.get(pair?.remoteCandidateId);
    const inbound = entries.find((stat) => stat.type === 'inbound-rtp' && stat.kind === 'video');
    const video = document.querySelector('video');
    return {
      connectionState: pc.connectionState,
      iceState: transport?.iceState ?? null,
      dtlsState: transport?.dtlsState ?? null,
      source: pair ? source : null,
      localType: local?.candidateType ?? null,
      remoteType: remote?.candidateType ?? null,
      relayProtocol: local?.relayProtocol ?? null,
      bytesReceived: inbound?.bytesReceived ?? null,
      framesDecoded: inbound?.framesDecoded ?? null,
      videoWidth: video?.videoWidth ?? null,
    };
  });
}

const report = {
  when: new Date().toISOString(),
  browser: null,
  platform: process.platform,
  network: process.env.NETWORK_LABEL ?? 'não informada',
  cases: [],
};
let browser;
try {
  const servers = modes.some((mode) => mode !== 'direct') ? await credentials() : [];
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME ?? chromium.executablePath() });
  report.browser = `Chromium ${browser.version()}`;
  for (const mode of modes) {
    const iceServers = urlsFor(servers, mode);
    const result = { mode, status: 'failed', host: null, viewer: null, code: null };
    report.cases.push(result);
    if (mode !== 'direct' && iceServers.length === 0) {
      result.code = 'ENDPOINT_ABSENT';
      continue;
    }
    const context = await browser.newContext();
    try {
      const host = await context.newPage();
      const viewer = await context.newPage();
      await createPeer(host, iceServers, mode === 'direct' ? 'all' : 'relay', true);
      await createPeer(viewer, iceServers, mode === 'direct' ? 'all' : 'relay', false);
      const offer = await description(host, null);
      const answer = await description(viewer, offer);
      await host.evaluate((remote) => window.__relayPc.setRemoteDescription(remote), answer);
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        result.host = await sample(host);
        result.viewer = await sample(viewer);
        if (result.viewer.videoWidth > 0 && result.viewer.bytesReceived > 0) break;
      }
      const paths = [result.host, result.viewer];
      const connected = paths.every((path) => path.connectionState === 'connected');
      const relayed = paths.every((path) => path.localType === 'relay');
      const observed = paths.every((path) => path.relayProtocol === mode);
      const media = result.viewer.videoWidth > 0 && result.viewer.bytesReceived > 0;
      result.status = connected && media && (mode === 'direct' ? !relayed : relayed && observed) ? 'passed' : 'failed';
      result.code = result.status === 'passed' ? null : 'PATH_OR_MEDIA_UNCONFIRMED';
    } catch (error) {
      result.code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'BROWSER_FAILURE';
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  if (process.env.REPORT_PATH) writeFileSync(process.env.REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  for (const item of report.cases) console.log(`${item.mode}: ${item.status}${item.code ? ` (${item.code})` : ''}`);
}
if (report.cases.length !== modes.length || report.cases.some((item) => item.status !== 'passed')) process.exitCode = 1;
