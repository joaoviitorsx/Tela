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
const sinal = await new Promise((resolve) => {
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
console.warn(`sinal : ${sinal}`);

if (sinal !== 'ok') {
  console.warn('\n  SINALIZAÇÃO FORA — ninguém consegue transmitir nem assistir.');
  process.exit(1);
}
console.warn(igual ? '\n  em dia.' : '\n  DESATUALIZADO — rode `pnpm release`.');
process.exit(igual ? 0 : 1);
