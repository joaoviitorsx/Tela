/**
 * O relay (TURN) de produção funciona de verdade?
 *
 * `check-prod` diz se o TURN está CONFIGURADO; isto prova que ele ALOCA:
 * abre a sinalização de produção como transmissor de um canal fixo de teste,
 * recebe a credencial TURN que o servidor emite, e força um
 * `RTCPeerConnection` a usar SÓ relay (`iceTransportPolicy: 'relay'`). Passa
 * se aparecer candidato `relay` — o provedor aceitou a credencial e
 * reservou um endereço (prova o Allocate autenticado; o caminho de dados,
 * CreatePermission e ChannelBind, só uma conexão de verdade exercita).
 * Mostra por qual transporte cada relay foi alcançado (`relayProtocol`: UDP,
 * TCP, TLS), que é o que importa para quem está atrás de firewall.
 *
 * Canal aleatório e dono aleatório: nada fica guardado, e o canal se libera
 * sozinho na carência de posse (5 min).
 *
 *   node e2e/relay-prod.mjs
 *   PROD_URL=https://... node e2e/relay-prod.mjs
 */
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { PROTOCOL_VERSION } from '../packages/shared/dist/index.js';

const URL_PROD = process.env.PROD_URL ?? 'https://tela.transmissao.workers.dev';
const SLUG = `relay-${randomBytes(5).toString('hex')}`;
const token = randomBytes(32).toString('base64url');

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
      const c = e.candidate;
      if (c?.candidate && / typ relay /.test(c.candidate)) {
        // `relayProtocol`: como se chegou AO relay (udp/tcp/tls); o protocolo do candidato é o do endereço relayed.
        candidatos.push(`${c.relayProtocol ?? '?'} via ${c.url ?? '?'}`);
      }
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
    const relays = candidatos;
    return {
      relayStatus: hosting.relayStatus ?? null,
      validadeH: hosting.expiresAt && hosting.issuedAt ? Math.round((hosting.expiresAt - hosting.issuedAt) / 3_600_000) : null,
      turnUrls,
      relays,
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
console.log(`candidatos relay: ${r.relays.length}`);
for (const c of r.relays) console.log(`  ${c}`);
const ok = r.relayStatus === 'available' && r.relays.length > 0;
console.log(ok ? '\n=== RELAY FUNCIONANDO ===' : '\n=== SEM RELAY — quem está atrás de CGNAT/NAT simétrico não conecta ===');
process.exit(ok ? 0 : 1);
