import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Em dev a API roda em :3333 e o Vite em :5173. Em produção o Caddy serve
    // os dois no mesmo domínio, então o front sempre chama caminho relativo.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3333',
        changeOrigin: true,
        ws: true, // o WebSocket de sinalização do modo P2P passa por aqui
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
