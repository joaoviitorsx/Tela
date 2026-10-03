import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { destinoDoContainer } from './src/desktop/troca-de-container';
import { proxyDeDev, versaoDoBuild } from './vite.config';

/**
 * O build do renderer do Tela Desktop (PLANO-desktop §3.6).
 *
 * É o mesmo app da web — mesmas rotas, mesmos hooks, mesmo `core/` — com três
 * diferenças, todas resolvidas aqui e em `src/desktop/`:
 *
 * - a entrada é `desktop.html`, sem Open Graph (ninguém cola `app://` no
 *   Discord) e com uma CSP própria;
 * - o container é `src/desktop/container.desktop.ts`, que estende os da web
 *   (`container.ts` e `container-transmissao.ts`). Rotas e hooks continuam
 *   importando os da web; é o plugin abaixo que troca o destino no build;
 * - a saída vai para `dist-desktop/`, que o Electron serve de `app://tela`.
 *
 * Em dev (`pnpm --filter @tela/web dev:desktop`) a porta é a 5174, para
 * conviver com o site em :5173 e o signaling em :3333.
 */
const RAIZ = fileURLToPath(new URL('.', import.meta.url));

function containerDesktop(): Plugin {
  return {
    name: 'tela:container-desktop',
    enforce: 'pre',
    async resolveId(fonte, importador, opcoes) {
      // Só o que pode ser o container: o resto não paga a resolução dupla.
      if (!/container(-transmissao)?(\.js|\.ts)?$/.test(fonte)) return null;
      const resolvido = await this.resolve(fonte, importador, { ...opcoes, skipSelf: true });
      if (resolvido === null) return null;
      return destinoDoContainer(RAIZ, resolvido.id, importador) ?? resolvido;
    },
  };
}

/**
 * Em dev o Electron abre `http://localhost:5174/`, e o Vite serviria o
 * `index.html` da web. Toda navegação de página (sem extensão, pedindo HTML)
 * cai no `desktop.html`; o F5 em `/recuperar` também.
 */
function entradaDesktopEmDev(): Plugin {
  return {
    name: 'tela:entrada-desktop',
    configureServer(servidor) {
      servidor.middlewares.use((req, _res, next) => {
        const url = req.url ?? '/';
        const caminho = url.split('?')[0] ?? '/';
        const pedeHtml = req.headers.accept?.includes('text/html') ?? false;
        if (pedeHtml && !caminho.includes('.')) req.url = `/desktop.html${url.slice(caminho.length)}`;
        next();
      });
    },
  };
}

/**
 * A CSP do app, só no build: em dev o plugin do React injeta script inline
 * para o HMR, que ela proibiria.
 *
 * `connect-src` é o signaling configurado, exatamente — mais `data:`/`blob:`
 * que o GLTFLoader e o worker de injeção usam. Sem `VITE_SIGNAL_URL` no build
 * fica `wss:` genérico, mas esse build já está errado (ver o container).
 * `style-src 'unsafe-inline'` é o que a folha das fontes do Google e qualquer
 * `<style>` injetado precisam; não abre execução de script.
 */
function cspDoApp(origemDoSignaling: string | null): Plugin {
  const conectar = origemDoSignaling ?? 'ws: wss:';
  const politica = [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    // `discord.com`: o aviso AO VIVO por webhook sai direto do app (o token do canal não passa pelo servidor).
    `connect-src 'self' ${conectar} https://discord.com data: blob:`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
  ].join('; ');
  return {
    name: 'tela:csp-desktop',
    transformIndexHtml(_html, ctx) {
      if (ctx.server !== undefined) return;
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: politica },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

function origemDe(url: string | undefined): string | null {
  if (url === undefined || url === '') return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, RAIZ, 'VITE_');
  return {
    base: '/',
    define: { __TELA_VERSION__: JSON.stringify(versaoDoBuild()) },
    plugins: [
      containerDesktop(),
      entradaDesktopEmDev(),
      cspDoApp(origemDe(env['VITE_SIGNAL_URL'])),
      react(),
      tailwindcss(),
    ],
    server: {
      port: 5174,
      proxy: proxyDeDev,
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      outDir: 'dist-desktop',
      rollupOptions: { input: 'desktop.html' },
    },
  };
});
