/**
 * Carimba o build com o commit que o gerou.
 *
 * Sem isto, "está no ar a versão certa?" só se responde procurando string no
 * bundle publicado — foi exatamente o que aconteceu: um deploy antigo ficou
 * de pé por horas parecendo atual, e a correção de um bug que já existia no
 * repositório não estava na URL que o usuário testava.
 *
 * Agora a resposta é uma requisição:
 *   curl https://<host>/version.json
 * e comparar com `git rev-parse --short HEAD`.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const raiz = resolve(import.meta.dirname, '..');
const destino = resolve(raiz, 'apps/web/dist/version.json');

function git(comando) {
  try {
    return execSync(comando, { cwd: raiz, encoding: 'utf8' }).trim();
  } catch {
    return 'desconhecido';
  }
}

const sujo = git('git status --porcelain') !== '';

const carimbo = {
  commit: git('git rev-parse --short HEAD'),
  branch: git('git rev-parse --abbrev-ref HEAD'),
  // `true` significa que o build saiu de uma árvore com alterações não
  // commitadas — útil para saber que o que está no ar não existe no histórico.
  sujo,
  data: new Date().toISOString(),
};

mkdirSync(dirname(destino), { recursive: true });
writeFileSync(destino, `${JSON.stringify(carimbo, null, 2)}\n`);
console.warn(`[stamp] ${carimbo.commit}${sujo ? ' (árvore suja)' : ''} → dist/version.json`);
