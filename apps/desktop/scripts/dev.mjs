/**
 * `pnpm --filter @tela/desktop dev`: o app apontando para o Vite do renderer
 * (`pnpm --filter @tela/web dev:desktop`, porta 5174) em vez do `app://`.
 *
 * É só `TELA_DESKTOP_URL=... electron dist/main/main.js`, num script para a
 * variável valer também no Windows sem trazer `cross-env` para o repositório.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** O caminho do binário, como o `electron/cli.js` resolve. */
const electron = require('electron');

const filho = spawn(electron, ['dist/main/main.js', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TELA_DESKTOP_URL: process.env.TELA_DESKTOP_URL ?? 'http://localhost:5174/desktop.html',
  },
});
filho.on('exit', (codigo) => process.exit(codigo ?? 1));
