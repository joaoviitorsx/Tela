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

type CapacidadesDesktop = {
  readonly nvenc: boolean;
  readonly nvencDetalhe: string;
  readonly seletorProprio: boolean;
};

type FonteDeCaptura = {
  readonly id: string;
  readonly nome: string;
  readonly tipo: 'tela' | 'janela';
  readonly miniatura: string | null;
  readonly icone: string | null;
};

type PedidoDeCapturaNativa = { readonly width: number; readonly height: number; readonly fps: number };

type RespostaDeCapturaNativa =
  | { readonly ok: true; readonly id: number; readonly fonte: { readonly width: number; readonly height: number }; readonly memoria: string }
  | { readonly ok: false; readonly erro: string };

type FimDaCapturaNativa = {
  readonly id: number;
  readonly motivo: 'FONTE_ENCERRADA' | 'PIPELINE' | 'PORTAL' | 'MORREU';
  readonly codigo: number | null;
};

/** Cópia de `PonteDesktop` em `apps/web/src/desktop/ponte.ts`. */
interface PonteDesktop {
  readonly plataforma: PlataformaDesktop;
  readonly versao: string;
  aoMudarVisibilidade(ouvinte: (visivel: boolean) => void): () => void;
  abrirNoNavegador(url: string): void;
  aoAbrirCanal(ouvinte: (slug: string) => void): () => void;
  capacidades(): Promise<CapacidadesDesktop>;
  listarFontes(): Promise<readonly FonteDeCaptura[]>;
  escolherFonte(id: string | null): Promise<boolean>;
  readonly capturaNativa: {
    iniciar(pedido: PedidoDeCapturaNativa): Promise<RespostaDeCapturaNativa>;
    parar(id: number): void;
    aoEncerrar(ouvinte: (fim: FimDaCapturaNativa) => void): () => void;
  };
}

/** Cópia de `CANAIS` em `apps/web/src/desktop/ponte.ts`. */
const CANAIS = {
  visibilidade: 'tela:visibilidade',
  abrirNoNavegador: 'tela:abrir-no-navegador',
  capacidades: 'tela:capacidades',
  listarFontes: 'tela:listar-fontes',
  escolherFonte: 'tela:escolher-fonte',
  capturaNativaIniciar: 'tela:captura-nativa-iniciar',
  capturaNativaParar: 'tela:captura-nativa-parar',
  capturaNativaPorta: 'tela:captura-nativa-porta',
  capturaNativaEncerrou: 'tela:captura-nativa-encerrou',
  abrirCanal: 'tela:abrir-canal',
} as const;

/** Cópia de `MARCA_DA_PORTA` em `ponte.ts`. */
const MARCA_DA_PORTA = 'tela:porta-nativa';

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

/** Assina um canal main → renderer entregando só o payload, nunca o evento. */
function assinar<T>(canal: string, ouvinte: (valor: T) => void): () => void {
  const interno = (_evento: IpcRendererEvent, valor: T): void => ouvinte(valor);
  ipcRenderer.on(canal, interno);
  return () => {
    ipcRenderer.removeListener(canal, interno);
  };
}

/*
  Canais que chegam por `tela://assistir/<slug>`. O preload roda ANTES do
  React: um link que abriu o app pode chegar sem ninguém assinando ainda.
  Guarda numa fila e entrega quando o primeiro ouvinte aparecer — sem isso o
  clique no link abria o app na home, sem canal nenhum.
*/
const canaisAguardando: string[] = [];
const ouvintesDeCanal = new Set<(slug: string) => void>();
ipcRenderer.on(CANAIS.abrirCanal, (_evento, slug: unknown) => {
  if (typeof slug !== 'string') return;
  if (ouvintesDeCanal.size === 0) canaisAguardando.push(slug);
  else for (const ouvinte of ouvintesDeCanal) ouvinte(slug);
});

const ponte: PonteDesktop = {
  plataforma: plataforma(),
  versao: versao(),

  aoMudarVisibilidade(ouvinte) {
    // O ouvinte da página recebe só o boolean: o `IpcRendererEvent` carrega o
    // `sender` e as portas, e nada disso atravessa a ponte.
    return assinar<unknown>(CANAIS.visibilidade, (visivel) => ouvinte(visivel === true));
  },

  abrirNoNavegador(url) {
    // Validar é com o main (`seguranca.ts`): ele conhece a origem do frame.
    ipcRenderer.send(CANAIS.abrirNoNavegador, String(url));
  },

  aoAbrirCanal(ouvinte) {
    ouvintesDeCanal.add(ouvinte);
    // Síncrono: com o StrictMode a primeira assinatura é desmontada em seguida,
    // e uma entrega adiada cairia num ouvinte que já saiu. A navegação é um
    // `pushState`, que sobrevive à remontagem.
    for (const slug of canaisAguardando.splice(0)) ouvinte(slug);
    return () => {
      ouvintesDeCanal.delete(ouvinte);
    };
  },

  capacidades: () => ipcRenderer.invoke(CANAIS.capacidades) as Promise<CapacidadesDesktop>,

  listarFontes: () => ipcRenderer.invoke(CANAIS.listarFontes) as Promise<readonly FonteDeCaptura[]>,

  escolherFonte: (id) =>
    ipcRenderer.invoke(CANAIS.escolherFonte, id === null ? null : String(id)) as Promise<boolean>,

  capturaNativa: {
    iniciar: (pedido) => ipcRenderer.invoke(CANAIS.capturaNativaIniciar, pedido) as Promise<RespostaDeCapturaNativa>,
    parar: (id) => ipcRenderer.send(CANAIS.capturaNativaParar, Number(id)),
    aoEncerrar: (ouvinte) => assinar<FimDaCapturaNativa>(CANAIS.capturaNativaEncerrou, ouvinte),
  },
};

/*
  A porta dos quadros do `tela-captura`. `contextBridge` não transfere
  `MessagePort`; o jeito documentado pelo Electron é o preload repassá-la ao
  mundo da página por `window.postMessage`, que transfere. A página confere
  a marca e o `id` (`apps/web/src/desktop/porta-nativa.ts`).
*/
ipcRenderer.on(CANAIS.capturaNativaPorta, (evento, dados: unknown) => {
  const id = typeof dados === 'object' && dados !== null ? (dados as { id?: unknown }).id : undefined;
  if (typeof id !== 'number' || evento.ports.length === 0) return;
  window.postMessage({ tipo: MARCA_DA_PORTA, id }, '*', evento.ports);
});

contextBridge.exposeInMainWorld('telaDesktop', ponte);
