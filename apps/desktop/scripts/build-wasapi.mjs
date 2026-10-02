/**
 * Compila o addon do "só o jogo" no Windows (D3) contra os cabeçalhos do
 * Electron do package.json — não contra o Node do sistema. Um addon N-API é
 * ABI-estável, mas os cabeçalhos do Electron são o que o `electron-builder`
 * e o runtime esperam, e o que a documentação do Electron manda usar.
 *
 *   pnpm --filter @tela/desktop native:win
 *
 * Só no Windows (o addon usa WASAPI). Em outras plataformas sai 0 e avisa: o
 * mesmo `pnpm install` roda em todas as máquinas.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ADDON = resolve(AQUI, '../native/wasapi-loopback');
const requerer = createRequire(import.meta.url);

if (process.platform !== 'win32') {
  console.log('[wasapi] pulado: o addon só existe no Windows.');
  process.exit(0);
}

const electron = requerer('electron/package.json').version;
const nodeGyp = join(dirname(requerer.resolve('node-gyp/package.json')), 'bin', 'node-gyp.js');

console.log(`[wasapi] node-gyp rebuild contra o Electron ${electron} (x64)`);
const r = spawnSync(
  process.execPath,
  [nodeGyp, 'rebuild', `--target=${electron}`, '--arch=x64', '--dist-url=https://electronjs.org/headers'],
  { cwd: ADDON, stdio: 'inherit' },
);
if (r.status !== 0) {
  console.error('[wasapi] a compilação falhou');
  process.exit(r.status ?? 1);
}

const modulo = join(ADDON, 'build', 'Release', 'wasapi_loopback.node');
if (!existsSync(modulo)) {
  console.error(`[wasapi] compilou, mas ${modulo} não existe`);
  process.exit(1);
}

// N-API é ABI-estável: o mesmo .node carrega no Node do runner. Isto prova que
// o módulo ABRE (DLLs, exportações) — o que, sem Windows na máquina de quem
// escreveu, é a única checagem automática possível. Enumerar sessões pode
// falhar num runner sem placa de som, e isso não é defeito do addon.
try {
  const addon = requerer(modulo);
  console.log(`[wasapi] carregou: versão ${addon.versao()}`);
  try {
    console.log(`[wasapi] sessões de áudio agora: ${addon.listarSessoes().length}`);
  } catch (erro) {
    console.log(`[wasapi] listarSessoes não rodou neste ambiente (esperado sem dispositivo de áudio): ${erro.message}`);
  }
} catch (erro) {
  console.error('[wasapi] o .node não carrega:', erro);
  process.exit(1);
}
