/**
 * Lê os fuses do binário EMPACOTADO e falha se algum voltou ao padrão (S-03).
 *
 *   node apps/desktop/scripts/verificar-fuses.mjs apps/desktop/release/linux-unpacked/tela
 *   node apps/desktop/scripts/verificar-fuses.mjs apps/desktop/release/win-unpacked/Tela.exe win32
 *
 * O segundo argumento é a plataforma do BINÁRIO (padrão: a de quem roda). A
 * ferramenta vai por `npx` com a versão fixa — não é dependência do repositório
 * (o lockfile não muda), e a versão fixa impede que um lançamento novo mude o
 * formato da saída debaixo do CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { divergencias, lerFuses } from './fuses.mjs';

const VERSAO_DA_FERRAMENTA = '1.8.0';

const [, , binario, plataforma = process.platform] = process.argv;
if (binario === undefined || !existsSync(binario)) {
  console.error(`uso: verificar-fuses.mjs <binário> [plataforma]; não achei "${binario ?? ''}"`);
  process.exit(2);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const saida = execFileSync(npx, ['--yes', `@electron/fuses@${VERSAO_DA_FERRAMENTA}`, 'read', '--app', resolve(binario)], {
  encoding: 'utf8',
  // Fora do workspace: dentro dele o npx procura o binário no `node_modules` do pnpm e não o acha.
  cwd: tmpdir(),
  // `.cmd` no Windows só roda por shell; os argumentos aqui são fixos ou o caminho do próprio CI.
  shell: process.platform === 'win32',
});
console.log(saida);

const problemas = divergencias(lerFuses(saida), plataforma);
if (problemas.length > 0) {
  for (const p of problemas) console.error(`::error title=Fuse do Electron::${p}`);
  process.exit(1);
}
console.log('fuses ok');
