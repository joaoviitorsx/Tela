import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';

function versaoDoBuild(): string | null {
  if (process.env['GITHUB_SHA']) return process.env['GITHUB_SHA'].slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: new URL('../..', import.meta.url), encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

export default defineConfig({
  define: { __TELA_VERSION__: JSON.stringify(versaoDoBuild()) },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Em dev o signaling roda em :3333 e o Vite em :5173. Em produção o front
    // é estático e aponta para o signaling por VITE_SIGNAL_URL — aqui o proxy
    // existe só para o front falar `/signal` no mesmo origin durante o
    // desenvolvimento.
    proxy: {
      // `^/signal` e não `/signal`: o slug vai no caminho (`/signal/joao`),
      // porque em Durable Objects é ele que escolhe a instância.
      '^/signal/.*': {
        target: 'ws://127.0.0.1:3333',
        ws: true,
        changeOrigin: true,
      },
      '/health': { target: 'http://127.0.0.1:3333', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
