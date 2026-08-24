/**
 * Responde "o que está no ar?" em um comando.
 *
 *   pnpm prod                        usa a URL de PROD_URL ou a padrão
 *   PROD_URL=https://... pnpm prod
 */
import { execSync } from 'node:child_process';

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
const url = (process.env.PROD_URL ?? 'https://tela.streaming.workers.dev').replace(/\/+$/, '');

const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();

const resposta = await fetch(`${url}/version.json`, { cache: 'no-store' }).catch(() => null);

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
console.warn(igual ? '\n  em dia.' : '\n  DESATUALIZADO — rode `pnpm release`.');
process.exit(igual ? 0 : 1);
