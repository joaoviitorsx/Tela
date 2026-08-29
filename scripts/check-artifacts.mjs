/**
 * Recusa deployar sem os artefatos, com uma mensagem que diz o que fazer.
 *
 * `wrangler.toml` aponta `main` para `dist/worker-entry.js` e os assets para
 * `../web/dist`. Nenhum dos dois existe num clone limpo — quem gera é
 * `pnpm cf:build`. Rodar `wrangler deploy` antes disso falha com um erro sobre
 * arquivo de entrada ausente, que não menciona build, nem workspace, nem qual
 * comando resolve.
 *
 * Foi exatamente o buraco em que o Workers Builds caiu: o comando de deploy
 * estava configurado e o de build não, então a CI tentava publicar um diretório
 * que nunca tinha sido construído.
 *
 * Roda pelo bloco `[build]` do `wrangler.toml`, então vale para QUALQUER
 * invocação de `wrangler deploy` — local, CI ou manual.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const raiz = resolve(import.meta.dirname, '..');

const exigidos = [
  ['apps/web/dist/index.html', 'o front estático'],
  ['apps/web/dist/version.json', 'o carimbo de versão'],
  ['apps/signaling/dist/worker-entry.js', 'o Worker'],
];

const faltando = exigidos.filter(([caminho]) => !existsSync(resolve(raiz, caminho)));

if (faltando.length > 0) {
  console.error('\n[deploy] falta build. Não há o que publicar:\n');
  for (const [caminho, oque] of faltando) console.error(`  ${caminho}  — ${oque}`);
  console.error(
    '\n  Local:           pnpm release\n' +
      '  Workers Builds:  o comando de BUILD tem que ser `pnpm run cf:build`.\n' +
      '                   Só o de deploy não basta — ele não constrói nada.\n',
  );
  process.exit(1);
}
