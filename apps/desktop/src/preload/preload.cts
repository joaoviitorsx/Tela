/**
 * A ponte do Tela Desktop: `window.telaDesktop`, só operações nomeadas.
 *
 * Roda com sandbox e `contextIsolation`, então é CommonJS (`.cts` → `.cjs`) e
 * só enxerga o `electron` e um `process` reduzido. Nada daqui dá ao renderer
 * acesso genérico ao `ipcRenderer` nem ao Node (PLANO-desktop §3.3–3.4).
 *
 * A FONTE DA VERDADE do contrato é `apps/web/src/desktop/ponte.ts`
 * (`PonteDesktop` e `CANAIS`). É outra compilação, então isto é uma cópia —
 * se mudar lá, muda aqui igual, e o typecheck do renderer é quem cobra o resto.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type PlataformaDesktop = 'win32' | 'linux' | 'darwin';

/** Cópia de `PonteDesktop` em `apps/web/src/desktop/ponte.ts`. */
interface PonteDesktop {
  readonly plataforma: PlataformaDesktop;
  readonly versao: string;
  aoMudarVisibilidade(ouvinte: (visivel: boolean) => void): () => void;
  abrirNoNavegador(url: string): void;
}

/** Cópia de `CANAIS` em `apps/web/src/desktop/ponte.ts`. */
const CANAIS = {
  visibilidade: 'tela:visibilidade',
  abrirNoNavegador: 'tela:abrir-no-navegador',
} as const;

/** Prefixo do argumento que o main põe em `additionalArguments` (`src/main/main.ts`). */
const ARGUMENTO_VERSAO = '--tela-versao=';

function plataforma(): PlataformaDesktop {
  const p = process.platform;
  return p === 'win32' || p === 'darwin' ? p : 'linux';
}

function versao(): string {
  const arg = process.argv.find((a) => a.startsWith(ARGUMENTO_VERSAO));
  return arg === undefined ? '0.0.0' : arg.slice(ARGUMENTO_VERSAO.length);
}

const ponte: PonteDesktop = {
  plataforma: plataforma(),
  versao: versao(),

  aoMudarVisibilidade(ouvinte) {
    // O ouvinte da página recebe só o boolean: o `IpcRendererEvent` carrega o
    // `sender` e as portas, e nada disso atravessa a ponte.
    const interno = (_evento: IpcRendererEvent, visivel: unknown): void => {
      ouvinte(visivel === true);
    };
    ipcRenderer.on(CANAIS.visibilidade, interno);
    return () => {
      ipcRenderer.removeListener(CANAIS.visibilidade, interno);
    };
  },

  abrirNoNavegador(url) {
    // Validar é com o main (`seguranca.ts`): ele conhece a origem do frame.
    ipcRenderer.send(CANAIS.abrirNoNavegador, String(url));
  },
};

contextBridge.exposeInMainWorld('telaDesktop', ponte);
