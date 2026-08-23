import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Em dev o signaling roda em :3333 e o Vite em :5173. Em produção o front
    // é estático e aponta para o signaling por VITE_SIGNAL_URL — aqui o proxy
    // existe só para o front falar `/signal` no mesmo origin durante o
    // desenvolvimento.
    proxy: {
      '/signal': {
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
