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

type AppComSom = { readonly id: string; readonly nome: string; readonly tocando: boolean; readonly icone: string | null };
type CapacidadesDeSom = { readonly jogo: { readonly disponivel: boolean; readonly motivo: string | null } };
type RespostaSomJogo =
  | { readonly ok: true; readonly app: string; readonly via: 'entrada'; readonly descricao: string }
  | { readonly ok: true; readonly app: string; readonly via: 'porta'; readonly id: number }
  | { readonly ok: false; readonly erro: 'INDISPONIVEL' | 'APP_NAO_ENCONTRADO' | 'FALHOU' | 'OCUPADO' };
type RespostaSomSistema =
  | { readonly ok: true; readonly descricao: string }
  | { readonly ok: false; readonly erro: 'INDISPONIVEL' | 'APP_NAO_ENCONTRADO' | 'FALHOU' | 'OCUPADO' };
type FimDoSomDoJogo = { readonly motivo: 'SINK_CAIU' | 'PROCESSO_ENCERROU' | 'COMPONENTE_CAIU' };

type EstadoAoVivo = {
  readonly noAr: boolean;
  readonly inicioMs: number | null;
  readonly assistindo: number;
  readonly capacidade: number;
  readonly link: string | null;
};
type AoFecharAoVivo = 'perguntar' | 'segundo-plano' | 'encerrar';
type AjustesDesktop = {
  readonly iniciarComSistema: boolean;
  readonly fecharEmSegundoPlano: boolean;
  readonly sempreNoTopoNoCompacto: boolean;
  readonly aoFecharAoVivo: AoFecharAoVivo;
  readonly atualizarAutomaticamente: boolean;
};
type EstadoDaAtualizacao = {
  readonly modo: 'automatica' | 'avisar' | 'desligada';
  readonly fase: 'desligada' | 'em-dia' | 'verificando' | 'disponivel' | 'baixando' | 'pronta' | 'erro';
  readonly versaoNova: string | null;
  readonly progresso: number | null;
  readonly ultimaVerificacaoMs: number | null;
  readonly erro: string | null;
  readonly adiada: boolean;
  readonly podeVerificar: boolean;
  readonly podeReiniciar: boolean;
  readonly pagina: string | null;
};
type RespostaDeAjustes = { readonly ajustes: AjustesDesktop; readonly bandeja: boolean; readonly autostartFalhou: boolean };
type ModoDaJanela = 'normal' | 'compacto';
type RespostaDeFechar = { readonly acao: 'segundo-plano' | 'encerrar' | 'cancelar'; readonly lembrar: boolean };
type MotivoDeParada = 'sair' | 'suspensao';

type EstadoDaJanela = { readonly focada: boolean; readonly maximizada: boolean; readonly telaCheia: boolean };

/** Cópia de `PonteDesktop` em `apps/web/src/desktop/ponte.ts`. */
interface PonteDesktop {
  readonly plataforma: PlataformaDesktop;
  readonly versao: string;
  aoMudarVisibilidade(ouvinte: (visivel: boolean) => void): () => void;
  abrirNoNavegador(url: string): void;
  aoAbrirCanal(ouvinte: (slug: string) => void): () => void;
  capacidades(): Promise<CapacidadesDesktop>;
  enviarEstadoAoVivo(estado: EstadoAoVivo): void;
  ajustes(): Promise<RespostaDeAjustes>;
  salvarAjustes(parcial: Partial<AjustesDesktop>): Promise<RespostaDeAjustes>;
  pedirModo(modo: ModoDaJanela): void;
  aoMudarModo(ouvinte: (modo: ModoDaJanela) => void): () => void;
  aoPerguntarFechar(ouvinte: () => void): () => void;
  responderFechar(resposta: RespostaDeFechar): void;
  aoPedirEncerrar(ouvinte: () => void): () => void;
  aoPedirParar(ouvinte: (motivo: MotivoDeParada) => void): () => void;
  paradaConcluida(): void;
  atualizacao(): Promise<EstadoDaAtualizacao | null>;
  aoMudarAtualizacao(ouvinte: (estado: EstadoDaAtualizacao) => void): () => void;
  verificarAtualizacao(): void;
  reiniciarEAtualizar(): void;
  listarFontes(): Promise<readonly FonteDeCaptura[]>;
  escolherFonte(id: string | null): Promise<boolean>;
  readonly som: {
    capacidades(): Promise<CapacidadesDeSom>;
    listarApps(): Promise<readonly AppComSom[]>;
    iniciarJogo(appId: string): Promise<RespostaSomJogo>;
    pararSom(): void;
    iniciarSistema(): Promise<RespostaSomSistema>;
    aoEncerrar(ouvinte: (fim: FimDoSomDoJogo) => void): () => void;
  };
  readonly janela: {
    minimizar(): void;
    alternarMaximizar(): void;
    fechar(): void;
    aoMudarEstado(ouvinte: (estado: EstadoDaJanela) => void): () => void;
  };
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
  somCapacidades: 'tela:som-capacidades',
  somListarApps: 'tela:som-listar-apps',
  somIniciarJogo: 'tela:som-iniciar-jogo',
  somParar: 'tela:som-parar',
  somIniciarSistema: 'tela:som-iniciar-sistema',
  somJogoEncerrou: 'tela:som-jogo-encerrou',
  somJogoPorta: 'tela:som-jogo-porta',
  abrirCanal: 'tela:abrir-canal',
  estadoAoVivo: 'tela:estado-ao-vivo',
  ajustes: 'tela:ajustes',
  salvarAjustes: 'tela:salvar-ajustes',
  pedirModo: 'tela:pedir-modo',
  modo: 'tela:modo',
  perguntarFechar: 'tela:perguntar-fechar',
  responderFechar: 'tela:responder-fechar',
  pedirEncerrar: 'tela:pedir-encerrar',
  parar: 'tela:parar',
  paradaConcluida: 'tela:parada-concluida',
  atualizacao: 'tela:atualizacao',
  atualizacaoMudou: 'tela:atualizacao-mudou',
  verificarAtualizacao: 'tela:verificar-atualizacao',
  reiniciarEAtualizar: 'tela:reiniciar-e-atualizar',
  janelaMinimizar: 'tela:janela-minimizar',
  janelaAlternarMaximizar: 'tela:janela-alternar-maximizar',
  janelaFechar: 'tela:janela-fechar',
  janelaEstado: 'tela:janela-estado',
} as const;

/** Cópia de `MARCA_DA_PORTA` em `ponte.ts`. */
const MARCA_DA_PORTA = 'tela:porta-nativa';
/** Cópia de `MARCA_DA_PORTA_SOM` em `ponte.ts`. */
const MARCA_DA_PORTA_SOM = 'tela:porta-som';

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

/*
  O modo da janela chega no `did-finish-load`, antes de o React assinar. Guarda
  o último e entrega na hora a quem assina — como o `abrirCanal`, mas por valor
  corrente: o modo é estado, não evento.
*/
let modoAtual: ModoDaJanela | null = null;
const ouvintesDeModo = new Set<(modo: ModoDaJanela) => void>();
ipcRenderer.on(CANAIS.modo, (_evento, modo: unknown) => {
  if (modo !== 'normal' && modo !== 'compacto') return;
  modoAtual = modo;
  for (const ouvinte of ouvintesDeModo) ouvinte(modo);
});

/*
  O estado da janela (foco, maximizada, tela cheia) chega no `did-finish-load`,
  antes de o React assinar: guarda o último, como o modo. Só booleanos passam;
  o resto do payload é descartado.
*/
let estadoDaJanela: EstadoDaJanela | null = null;
const ouvintesDaJanela = new Set<(estado: EstadoDaJanela) => void>();
ipcRenderer.on(CANAIS.janelaEstado, (_evento, bruto: unknown) => {
  if (typeof bruto !== 'object' || bruto === null) return;
  const b = bruto as Record<string, unknown>;
  estadoDaJanela = { focada: b['focada'] === true, maximizada: b['maximizada'] === true, telaCheia: b['telaCheia'] === true };
  for (const ouvinte of ouvintesDaJanela) ouvinte(estadoDaJanela);
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

  enviarEstadoAoVivo: (estado) => ipcRenderer.send(CANAIS.estadoAoVivo, estado),
  ajustes: () => ipcRenderer.invoke(CANAIS.ajustes) as Promise<RespostaDeAjustes>,
  salvarAjustes: (parcial) => ipcRenderer.invoke(CANAIS.salvarAjustes, parcial) as Promise<RespostaDeAjustes>,
  pedirModo: (modo) => ipcRenderer.send(CANAIS.pedirModo, modo),
  aoMudarModo(ouvinte) {
    ouvintesDeModo.add(ouvinte);
    if (modoAtual !== null) ouvinte(modoAtual);
    return () => {
      ouvintesDeModo.delete(ouvinte);
    };
  },
  aoPerguntarFechar: (ouvinte) => assinar<unknown>(CANAIS.perguntarFechar, () => ouvinte()),
  responderFechar: (resposta) => ipcRenderer.send(CANAIS.responderFechar, resposta),
  aoPedirEncerrar: (ouvinte) => assinar<unknown>(CANAIS.pedirEncerrar, () => ouvinte()),
  aoPedirParar: (ouvinte) =>
    assinar<unknown>(CANAIS.parar, (motivo) => ouvinte(motivo === 'suspensao' ? 'suspensao' : 'sair')),
  paradaConcluida: () => ipcRenderer.send(CANAIS.paradaConcluida),

  atualizacao: () => ipcRenderer.invoke(CANAIS.atualizacao) as Promise<EstadoDaAtualizacao | null>,
  // O payload vem do main, mas passa por aqui antes da página: só objeto, nunca o evento.
  aoMudarAtualizacao: (ouvinte) =>
    assinar<unknown>(CANAIS.atualizacaoMudou, (estado) => {
      if (typeof estado === 'object' && estado !== null) ouvinte(estado as EstadoDaAtualizacao);
    }),
  verificarAtualizacao: () => ipcRenderer.send(CANAIS.verificarAtualizacao),
  reiniciarEAtualizar: () => ipcRenderer.send(CANAIS.reiniciarEAtualizar),

  listarFontes: () => ipcRenderer.invoke(CANAIS.listarFontes) as Promise<readonly FonteDeCaptura[]>,

  escolherFonte: (id) =>
    ipcRenderer.invoke(CANAIS.escolherFonte, id === null ? null : String(id)) as Promise<boolean>,

  som: {
    capacidades: () => ipcRenderer.invoke(CANAIS.somCapacidades) as Promise<CapacidadesDeSom>,
    listarApps: () => ipcRenderer.invoke(CANAIS.somListarApps) as Promise<readonly AppComSom[]>,
    iniciarJogo: (appId) => ipcRenderer.invoke(CANAIS.somIniciarJogo, String(appId)) as Promise<RespostaSomJogo>,
    pararSom: () => ipcRenderer.send(CANAIS.somParar),
    iniciarSistema: () => ipcRenderer.invoke(CANAIS.somIniciarSistema) as Promise<RespostaSomSistema>,
    aoEncerrar: (ouvinte) => assinar<FimDoSomDoJogo>(CANAIS.somJogoEncerrou, ouvinte),
  },

  janela: {
    // Sem payload, de propósito: o main sabe qual é a janela.
    minimizar: () => ipcRenderer.send(CANAIS.janelaMinimizar),
    alternarMaximizar: () => ipcRenderer.send(CANAIS.janelaAlternarMaximizar),
    fechar: () => ipcRenderer.send(CANAIS.janelaFechar),
    aoMudarEstado(ouvinte) {
      ouvintesDaJanela.add(ouvinte);
      if (estadoDaJanela !== null) ouvinte(estadoDaJanela);
      return () => {
        ouvintesDaJanela.delete(ouvinte);
      };
    },
  },

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

/*
  A porta do PCM do "só o jogo" no Windows (D3): mesmo caminho da porta de
  quadros — o `contextBridge` não transfere `MessagePort`, o preload a entrega
  ao mundo da página por `window.postMessage` com a marca de `ponte.ts`.
*/
ipcRenderer.on(CANAIS.somJogoPorta, (evento, dados: unknown) => {
  const id = typeof dados === 'object' && dados !== null ? (dados as { id?: unknown }).id : undefined;
  if (typeof id !== 'number' || evento.ports.length === 0) return;
  window.postMessage({ tipo: MARCA_DA_PORTA_SOM, id }, '*', evento.ports);
});

contextBridge.exposeInMainWorld('telaDesktop', ponte);
