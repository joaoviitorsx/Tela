/**
 * O relay (TURN) de produção funciona de verdade?
 *
 * `check-prod` diz se o TURN está CONFIGURADO; isto prova que ele ALOCA:
 * abre a sinalização de produção como transmissor de um canal fixo de teste,
 * recebe a credencial TURN que o servidor emite, e força um
 * `RTCPeerConnection` a usar SÓ relay (`iceTransportPolicy: 'relay'`). Passa
 * se aparecer candidato `relay` — a Cloudflare aceitou a credencial e
 * reservou um endereço. Mostra também quais transportes alocaram (UDP, TCP,
 * TLS 443), que é o que importa para quem está atrás de firewall.
 *
 * Canal fixo (`tela-relay-check`) com o token de dono guardado FORA do repo,
 * em ~/.config/tela/relay-check-token: rodar de novo não reserva canal novo.
 *
 *   node e2e/relay-prod.mjs
 *   PROD_URL=https://... node e2e/relay-prod.mjs
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PROTOCOL_VERSION } from '../packages/shared/dist/index.js';

const URL_PROD = process.env.PROD_URL ?? 'https://tela.transmissao.workers.dev';
const SLUG = 'tela-relay-check';

const pasta = join(homedir(), '.config', 'tela');
const arquivoDoToken = join(pasta, 'relay-check-token');
let token;
try {
  token = readFileSync(arquivoDoToken, 'utf8').trim();
} catch {
  token = randomBytes(32).toString('base64url');
  mkdirSync(pasta, { recursive: true });
  writeFileSync(arquivoDoToken, token, { mode: 0o600 });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
// A origem do próprio Worker: a sinalização só aceita upgrade dela (TELA-019).
await page.goto(`${URL_PROD}/robots.txt`);

const r = await page.evaluate(
  async ({ slug, token, protocol }) => {
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/signal/${slug}`);
    const hosting = await new Promise((resolve) => {
      const prazo = setTimeout(() => resolve({ erro: 'sinalização sem resposta em 10 s' }), 10_000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'host', protocol, slug, ownerToken: token }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'hosting') {
          clearTimeout(prazo);
          resolve(m);
        } else if (m.type === 'error') {
          clearTimeout(prazo);
          resolve({ erro: m.code ?? 'erro' });
        }
      };
      ws.onerror = () => resolve({ erro: 'WebSocket falhou' });
    });
    if (hosting.erro) {
      ws.close();
      return hosting;
    }
    const turnUrls = hosting.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter((u) => /^turns?:/.test(u));
    const pc = new RTCPeerConnection({ iceServers: hosting.iceServers, iceTransportPolicy: 'relay' });
    pc.createDataChannel('x');
    const candidatos = [];
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) candidatos.push(e.candidate.candidate);
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      const fim = setTimeout(resolve, 12_000);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(fim);
          resolve();
        }
      };
    });
    pc.close();
    ws.close();
    const relays = candidatos.filter((c) => / typ relay /.test(c));
    return {
      relayStatus: hosting.relayStatus ?? null,
      validadeH: hosting.expiresAt && hosting.issuedAt ? Math.round((hosting.expiresAt - hosting.issuedAt) / 3_600_000) : null,
      turnUrls,
      relays: relays.map((c) => c.split(' ').slice(2, 3).concat(c.match(/ (udp|tcp) /i)?.[1] ?? '?').join('/')),
    };
  },
  { slug: SLUG, token, protocol: PROTOCOL_VERSION },
);
await browser.close();

if (r.erro) {
  console.error(`relay : sinalização recusou (${r.erro})`);
  process.exit(1);
}
console.log(`relayStatus     : ${r.relayStatus}`);
console.log(`validade        : ${r.validadeH ?? '?'} h`);
console.log(`URLs TURN       : ${r.turnUrls.length === 0 ? 'NENHUMA' : r.turnUrls.join('  ')}`);
console.log(`candidatos relay: ${r.relays.length}${r.relays.length > 0 ? ` (${r.relays.join(', ')})` : ''}`);
const ok = r.relayStatus === 'available' && r.relays.length > 0;
console.log(ok ? '\n=== RELAY FUNCIONANDO ===' : '\n=== SEM RELAY — quem está atrás de CGNAT/NAT simétrico não conecta ===');
process.exit(ok ? 0 : 1);
