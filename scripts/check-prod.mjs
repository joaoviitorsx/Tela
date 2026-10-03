/**
 * Responde "o que está no ar?" em um comando.
 *
 *   pnpm prod                        usa a URL de PROD_URL ou a padrão
 *   PROD_URL=https://... pnpm prod
 */
import { execSync } from 'node:child_process';
// A versão do protocolo vem do build do pacote compartilhado: número fixo aqui
// quebraria a checagem na próxima troca de versão — e passaria a mentir.
import { PROTOCOL_VERSION } from '../packages/shared/dist/index.js';

// URL real do Worker publicado.
//
// O formato é `<worker>.<subdomínio-da-conta>.workers.dev`: `tela` vem do
// `name` no wrangler.toml, `streaming` é o subdomínio da conta (painel, não
// código), e `.workers.dev` é da Cloudflare e não se remove.
//
// Uma versão anterior apontava para um subdomínio que nunca existiu, e o
// `pnpm prod` respondia "sem carimbo de versão" mesmo com o deploy certo no
// ar. Ferramenta de verificação que mente é pior que nenhuma: some com a
// única defesa automática contra publicar coisa velha.
/**
 * URL de produção. O subdomínio `transmissao` é da CONTA e se troca no painel
 * da Cloudflare, não aqui — o formato é `<worker>.<subdomínio>.workers.dev`.
 *
 * A candidata do subdomínio antigo foi removida assim que ele parou de rotear.
 * Candidata morta que ninguém apaga é como esta checagem ficou cega antes.
 */
const CANDIDATAS = process.env.PROD_URL
  ? [process.env.PROD_URL]
  : ['https://tela.transmissao.workers.dev'];

const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();

let url = CANDIDATAS[0];
let resposta = null;
let alcancou = false;
for (const candidata of CANDIDATAS) {
  const r = await fetch(`${candidata}/version.json`, { cache: 'no-store' }).catch(() => null);
  if (r === null) continue;
  alcancou = true;
  if (r.ok) {
    url = candidata;
    resposta = r;
    break;
  }
}

/**
 * "Não respondeu" é diferente de "respondeu sem carimbo".
 *
 * Sem esta distinção, um DNS que não resolve — cache negativo, VPN, rede caída
 * — era reportado como "build anterior a este mecanismo", mandando quem lê
 * publicar de novo para consertar um problema que não está no build. Errar o
 * diagnóstico é pior que não diagnosticar.
 */
if (!alcancou) {
  console.error(`local : ${head}`);
  console.error(`no ar : não foi possível ALCANÇAR ${CANDIDATAS.join(' nem ')}`);
  console.error('        DNS, VPN ou rede — não é problema de build. Tente de outra rede,');
  console.error('        ou `PROD_URL=https://... pnpm prod`.');
  process.exit(2);
}

/**
 * O SPA fallback devolve `index.html` com status 200 para qualquer caminho que
 * não exista — então `resposta.ok` não prova nada aqui. Um build sem carimbo
 * responde HTML, e é preciso ler o corpo para saber.
 */
let prod = null;
if (resposta !== null && resposta.ok) {
  const corpo = await resposta.text();
  try {
    prod = JSON.parse(corpo);
  } catch {
    prod = null;
  }
}

if (prod === null || typeof prod.commit !== 'string') {
  console.error(`local : ${head}`);
  console.error(`no ar : sem carimbo de versão em ${url}`);
  console.error('        build anterior a este mecanismo — publique de novo com `pnpm deploy`.');
  process.exit(1);
}
const igual = prod.commit === head;

console.warn(`local : ${head}`);
console.warn(`no ar : ${prod.commit}  (${prod.data})${prod.sujo ? '  [árvore suja]' : ''}`);

/**
 * A versão certa no ar não prova que o serviço está no ar.
 *
 * Em 2026-09-28 esta checagem respondeu "em dia" com a sinalização inteira
 * devolvendo 500: o Durable Object lançava no construtor por causa de dois
 * secrets de TURN vazios, e o front estático — que é o que `version.json`
 * mede — continuava servindo normalmente. Ninguém conseguia transmitir.
 *
 * Então abre a sinalização de verdade e pede para ASSISTIR um canal que não
 * existe: a resposta esperada é `NOT_HOSTING`. Isso atravessa Worker, Durable
 * Object e protocolo sem reservar slug nem gastar credencial TURN.
 */
const testarSinal = () => new Promise((resolve) => {
  const slug = `saude${Math.random().toString(36).slice(2, 10)}`;
  const endereco = `${url.replace(/^http/, 'ws')}/signal/${slug}`;
  let ws;
  try {
    ws = new WebSocket(endereco, { headers: { Origin: url } });
  } catch (erro) {
    resolve(`não abriu (${erro instanceof Error ? erro.message : 'erro'})`);
    return;
  }
  const prazo = setTimeout(() => {
    ws.close();
    resolve('sem resposta em 8 s');
  }, 8_000);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      type: 'watch', protocol: PROTOCOL_VERSION, slug,
      name: 'check-prod', viewerKey: 'k'.repeat(22),
    }));
  });
  ws.addEventListener('message', (evento) => {
    clearTimeout(prazo);
    let msg = null;
    try { msg = JSON.parse(String(evento.data)); } catch { /* resposta não-JSON */ }
    ws.close();
    resolve(msg?.type === 'error' && msg.code === 'NOT_HOSTING' ? 'ok' : `resposta inesperada: ${String(evento.data).slice(0, 80)}`);
  });
  ws.addEventListener('error', () => {
    clearTimeout(prazo);
    resolve('handshake recusado (Worker respondeu sem 101 — ver `wrangler tail`)');
  });
});
/*
  Até três tentativas, 6 s entre elas. Logo depois de um deploy, a borda da
  Cloudflare ainda serve o Worker anterior por alguns segundos — medido em
  2026-10-01: a primeira tentativa recebeu PROTOCOL_MISMATCH da versão velha e
  a seguinte, ok. Queda de verdade falha nas três.
*/
let sinal = await testarSinal();
for (let i = 1; i < 3 && sinal !== 'ok'; i += 1) {
  console.warn(`sinal : ${sinal} — tentando de novo (${i + 1}/3)`);
  await new Promise((r) => setTimeout(r, 6_000));
  sinal = await testarSinal();
}
console.warn(`sinal : ${sinal}`);

if (sinal !== 'ok') {
  console.warn('\n  SINALIZAÇÃO FORA — ninguém consegue transmitir nem assistir.');
  process.exit(1);
}
// A versão vem antes do relay: uma publicação que não pegou não pode sumir
// atrás de outro alarme. Códigos: 1 = desatualizado ou sinal, 3 = relay.
console.warn(igual ? 'versão: em dia' : 'versão: DESATUALIZADO — rode `pnpm release`.');

/**
 * Sinal no ar não prova que todo mundo CONECTA.
 *
 * De 2026-09-28 a 2026-10-03 a produção ficou só com STUN — os dois secrets
 * do TURN existiam e estavam VAZIOS, e o Worker degradava calado — e esta
 * checagem dizia "em dia". Quem estava atrás de CGNAT, NAT simétrico ou
 * firewall via "sem conexão" (`ice: NO_ROUTE`, `turn: RELAY_NOT_CONFIGURED`).
 *
 * Duas camadas: o `/health` diz o que está CONFIGURADO; um handshake de
 * transmissor num canal descartável diz se o servidor CONSEGUE emitir a
 * credencial (`hosting.relayStatus`) — chave trocada, revogada ou com lixo no
 * fim aparece aqui, e não no `/health`. O canal aleatório se libera sozinho
 * na carência de posse (5 min); nenhum token fica guardado.
 */
const relayFalhou = (msg) => {
  console.warn(`relay : ${msg}`);
  console.warn('        docs/DEPLOY.md, seção TURN.');
  process.exit(3);
};
const saude = await fetch(`${url}/health`, { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
const ice = saude?.iceConfig;
if (ice === undefined || ice === null) relayFalhou('/health não respondeu');
if (ice.valid !== true) relayFalhou(`CONFIGURAÇÃO INVÁLIDA (${(ice.problems ?? []).join(', ')}) — produção só com STUN`);
const horas = (s) => (s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`);
const modo = ice.cloudflareConfigured === true
  ? `Cloudflare · credencial de ${horas(ice.ttlSeconds)}`
  : ice.coturnModo === 'segredo'
    ? `coturn · credencial de ${horas(ice.ttlSeconds)}`
    : ice.coturnModo === 'estatico' && ice.estaticoAceito === true
      ? 'senha fixa (plano grátis) · aceito com TURN_ESTATICO'
      : null;
if (modo === null) {
  relayFalhou(ice.coturnModo === 'estatico'
    ? 'senha fixa gravada SEM `TURN_ESTATICO = "aceito"` — o Worker não a entrega'
    : 'NÃO CONFIGURADO — quem está atrás de CGNAT ou NAT simétrico não conecta');
}

const emitirRelay = () => new Promise((resolve) => {
  const slug = `saude-relay-${Math.random().toString(36).slice(2, 10)}`;
  const dono = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  let ws;
  try {
    ws = new WebSocket(`${url.replace(/^http/, 'ws')}/signal/${slug}`, { headers: { Origin: url } });
  } catch {
    resolve('não abriu');
    return;
  }
  const prazo = setTimeout(() => {
    ws.close();
    resolve('sem resposta em 10 s');
  }, 10_000);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'host', protocol: PROTOCOL_VERSION, slug, ownerToken: dono })));
  ws.addEventListener('message', (evento) => {
    let msg = null;
    try {
      msg = JSON.parse(String(evento.data));
    } catch {
      return;
    }
    if (msg?.type !== 'hosting' && msg?.type !== 'error') return;
    clearTimeout(prazo);
    ws.close();
    resolve(msg.type === 'hosting' ? (msg.relayStatus ?? 'sem relayStatus') : `erro ${msg.code ?? '?'}`);
  });
  ws.addEventListener('error', () => {
    clearTimeout(prazo);
    resolve('WebSocket falhou');
  });
});
const emissao = await emitirRelay();
if (emissao !== 'available') {
  relayFalhou(`${modo}, mas o servidor NÃO emitiu relay (${emissao}) — chave errada, revogada ou provedor fora`);
}
console.warn(`relay : ${modo} · emissão ok`);

console.warn(igual ? '\n  em dia.' : '\n  DESATUALIZADO — rode `pnpm release`.');
process.exit(igual ? 0 : 1);
