/**
 * Recusa publicar um build que não corresponde ao repositório.
 *
 * `wrangler deploy` envia o que estiver em `apps/web/dist`, sem perguntar se
 * aquilo foi gerado agora ou na semana passada. Um deploy de bundle velho não
 * dá erro nenhum — ele "funciona", só que com o código errado, e a pessoa
 * testa a versão antiga achando que testa a nova.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const raiz = resolve(import.meta.dirname, '..');
const carimbo = JSON.parse(readFileSync(resolve(raiz, 'apps/web/dist/version.json'), 'utf8'));
const head = execSync('git rev-parse --short HEAD', { cwd: raiz, encoding: 'utf8' }).trim();

if (carimbo.commit !== head) {
  console.error(
    `[deploy] o build em dist/ é do commit ${carimbo.commit}, mas HEAD é ${head}.\n` +
      '         Rode `pnpm deploy` (que reconstrói) em vez de `wrangler deploy` direto.',
  );
  process.exit(1);
}

if (carimbo.sujo) {
  console.warn(
    `[deploy] atenção: build gerado com alterações não commitadas.\n` +
      '         O que vai para produção não existe no histórico.',
  );
}

console.warn(`[deploy] build ${carimbo.commit} confere com HEAD. Publicando.`);
