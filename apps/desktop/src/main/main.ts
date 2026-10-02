/**
 * O processo principal do Tela Desktop — D1, a casca; D2, a captura
 * (PLANO-desktop §3).
 *
 * Uma janela, que carrega a interface do site de `app://tela/` (o build de
 * `apps/web` para desktop) e fica quase ociosa: avisa a página quando a janela
 * some, abre links no navegador do sistema, lista telas e janelas para o
 * seletor próprio, entrega a captura escolhida e, no Linux com NVENC, sobe o
 * `tela-captura` e liga a saída dele à página por uma `MessagePort`. A
 * transmissão inteira vive no renderer, com o `core/` intacto.
 *
 * Em desenvolvimento, `TELA_DESKTOP_URL` aponta para o Vite
 * (`scripts/dev.mjs`); sem ela, o `app://` serve `apps/web/dist-desktop`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  type DesktopCapturerSource,
  ipcMain,
  Menu,
  MessageChannelMain,
  type MessagePortMain,
  type NativeImage,
  net,
  protocol,
  session,
  shell,
  type WebContents,
} from 'electron';
import {
  CapturaNativa,
  lerTokenDoPortal,
  ordemValida,
  pedidoDeCapturaValido,
  type ProcessoFilho,
  serializarTokenDoPortal,
  sondarNvenc,
} from './captura-nativa.js';
import {
  type EscolhaPendente,
  escolhaValida,
  type FonteDeCaptura,
  mapearFontes,
  QUALIDADE_DA_MINIATURA,
  respostaDeCaptura,
  TAMANHO_DA_MINIATURA,
  tipoDaFonte,
  usaSeletorProprio,
} from './fontes-de-captura.js';
import { ESQUEMA_APP, ORIGEM_APP, PAGINA_UNICA, resolverArquivo } from './protocolo-app.js';
import {
  decidirJanelaNova,
  origemPermitida,
  origensPermitidas,
  permissaoConcedida,
  podeNavegar,
  urlParaAbrirNoNavegador,
} from './seguranca.js';

/**
 * Nomes dos canais IPC. A fonte da verdade é `apps/web/src/desktop/ponte.ts`
 * (`CANAIS`); o main não importa de `apps/web` porque é outra compilação, então
 * copia os nomes iguais. O preload (`src/preload/preload.cts`) faz o mesmo.
 */
const CANAIS = {
  /** main → renderer, `boolean` */
  visibilidade: 'tela:visibilidade',
  /** renderer → main, `string` (URL) */
  abrirNoNavegador: 'tela:abrir-no-navegador',
  capacidades: 'tela:capacidades',
  listarFontes: 'tela:listar-fontes',
  escolherFonte: 'tela:escolher-fonte',
  capturaNativaIniciar: 'tela:captura-nativa-iniciar',
  capturaNativaParar: 'tela:captura-nativa-parar',
  capturaNativaPorta: 'tela:captura-nativa-porta',
  capturaNativaEncerrou: 'tela:captura-nativa-encerrou',
} as const;

/**
 * A versão vai para o preload por `additionalArguments` (lido em
 * `process.argv`), síncrono e sem canal IPC — o preload não precisa esperar
 * nem bloquear o renderer para preencher `telaDesktop.versao`. O prefixo é
 * copiado no preload.
 */
const ARGUMENTO_VERSAO = '--tela-versao=';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PRELOAD = resolve(AQUI, '../preload/preload.cjs');
/**
 * Onde está o renderer compilado: empacotado, vai junto em `resources/web`;
 * no repositório, é a saída do `vite build` desktop de `apps/web`.
 */
const RAIZ_DO_RENDERER = app.isPackaged
  ? resolve(process.resourcesPath, 'web')
  : resolve(AQUI, '../../../web/dist-desktop');

/**
 * O `tela-captura` (nativo/linux): empacotado, `resources/nativo` (ver
 * `electron-builder.yml`); no repositório, a saída de `nativo/linux/build.sh`.
 * Só no Linux — nas outras plataformas o caminho fica vazio e a sonda nem roda.
 */
const CAMINHO_DO_HELPER =
  process.platform !== 'linux'
    ? null
    : app.isPackaged
      ? resolve(process.resourcesPath, 'nativo', 'tela-captura')
      : resolve(AQUI, '../../nativo/linux/build/tela-captura');

/** O token do portal, para a próxima transmissão não perguntar de novo (D0c). */
const ARQUIVO_DO_TOKEN = join(app.getPath('userData'), 'captura-portal.json');

const URL_DE_DESENVOLVIMENTO = process.env['TELA_DESKTOP_URL'];
const ORIGENS = origensPermitidas(URL_DE_DESENVOLVIMENTO);
const URL_INICIAL = URL_DE_DESENVOLVIMENTO ?? `${ORIGEM_APP}/${PAGINA_UNICA}`;
const SELETOR_PROPRIO = usaSeletorProprio(process.platform, process.env);

/**
 * `standard` dá a `app://tela` uma origem de verdade — `localStorage` (o
 * `ownerToken` mora lá), cookies e caminhos relativos funcionam como em HTTPS.
 * `secure` libera o que o Chromium reserva a contextos seguros: `getDisplayMedia`,
 * WebCodecs, clipboard. Tem de ser antes do `ready`.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: ESQUEMA_APP,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function existeArquivo(caminho: string): boolean {
  try {
    return statSync(caminho).isFile();
  } catch {
    return false;
  }
}

function registrarProtocoloApp(): void {
  protocol.handle(ESQUEMA_APP, (pedido) => {
    const arquivo = resolverArquivo(RAIZ_DO_RENDERER, pedido.url, existeArquivo);
    if (arquivo === null) return new Response(null, { status: 404 });
    // `net.fetch` de `file:` põe o `Content-Type` certo pela extensão, e o
    // `resolverArquivo` já garantiu que o caminho está dentro da raiz.
    return net.fetch(pathToFileURL(arquivo).toString());
  });
}

let janela: BrowserWindow | null = null;

function visivel(j: BrowserWindow): boolean {
  return j.isVisible() && !j.isMinimized();
}

function avisarVisibilidade(j: BrowserWindow, valor: boolean): void {
  if (!j.isDestroyed()) j.webContents.send(CANAIS.visibilidade, valor);
}

function criarJanela(): BrowserWindow {
  const j = new BrowserWindow({
    title: 'Tela',
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#000000',
    // Aparece pronta: sem o flash branco antes do primeiro quadro da página.
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      /*
        A janela minimizada continua transmitindo (§3.2). Com throttling o
        Chromium derruba timers e rAF da página escondida, e a captura, o
        encoder e as malhas vão junto. O preço é que a página não sabe sozinha
        quando sumiu — por isso o main avisa pelo canal de visibilidade.
      */
      backgroundThrottling: false,
      // `RTCRtpScriptTransform` com `setMetadata`: o transporte "um encode, N
      // envios" (D0b) troca o quadro-isca pelo real e precisa reescrever os
      // metadados do quadro codificado.
      enableBlinkFeatures: 'RTCEncodedFrameSetMetadata',
      additionalArguments: [`${ARGUMENTO_VERSAO}${app.getVersion()}`],
    },
  });

  j.once('ready-to-show', () => j.show());

  // Visibilidade (§3.2): a página pausa animação e prévia quando some.
  j.on('minimize', () => avisarVisibilidade(j, false));
  j.on('hide', () => avisarVisibilidade(j, false));
  j.on('restore', () => avisarVisibilidade(j, true));
  j.on('show', () => avisarVisibilidade(j, true));
  // Ao carregar, a página recebe o estado atual — pode ter nascido minimizada.
  j.webContents.on('did-finish-load', () => avisarVisibilidade(j, visivel(j)));

  j.webContents.on('render-process-gone', (_evento, detalhes) => {
    // D4 mostra "transmissão caiu" e preserva o diagnóstico (§3.1, §5). Por
    // ora só registra: nunca fingir continuidade. O `tela-captura` não pode
    // ficar codificando para ninguém.
    console.error(`[tela] renderer caiu: ${detalhes.reason} (código ${detalhes.exitCode})`);
    capturaNativa.pararTudo();
  });

  j.on('closed', () => {
    janela = null;
  });

  void j.loadURL(URL_INICIAL);
  return j;
}

/** Trazer a janela de volta, de onde quer que esteja — segunda instância, bandeja (D4). */
function mostrarJanela(): void {
  if (janela === null || janela.isDestroyed()) {
    janela = criarJanela();
    return;
  }
  if (janela.isMinimized()) janela.restore();
  janela.show();
  janela.focus();
}

/**
 * A política de todo `WebContents` (§3.4): navegar só dentro da interface,
 * janela nova nunca — um link `https:` vai para o navegador do sistema.
 * Registrado no `app` e não na janela para valer para qualquer `WebContents`
 * que apareça, hoje ou num marco futuro.
 */
function blindar(conteudo: WebContents): void {
  conteudo.on('will-navigate', (evento, url) => {
    if (!podeNavegar(url, ORIGENS)) evento.preventDefault();
  });
  conteudo.setWindowOpenHandler(({ url }) => {
    if (decidirJanelaNova(url) === 'abrir-no-navegador') void shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------- captura: fontes */

/**
 * A última listagem entregue ao renderer, por id. É daqui que sai o objeto
 * que o `setDisplayMediaRequestHandler` responde — o renderer só manda o id,
 * e só um id que esteve nesta lista é aceito (`escolhaValida`).
 */
let ultimaListagem = new Map<string, DesktopCapturerSource>();
/** A escolha que o PRÓXIMO `getDisplayMedia` consome. Uma vez só. */
let escolhaPendente: EscolhaPendente<DesktopCapturerSource> | null = null;

function imagemEmDataUrl(imagem: NativeImage | null | undefined, formato: 'jpeg' | 'png'): string | null {
  if (imagem == null || imagem.isEmpty()) return null;
  const bytes = formato === 'jpeg' ? imagem.toJPEG(QUALIDADE_DA_MINIATURA) : imagem.toPNG();
  return `data:image/${formato};base64,${bytes.toString('base64')}`;
}

async function listarFontes(): Promise<readonly FonteDeCaptura[]> {
  const fontes = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { ...TAMANHO_DA_MINIATURA },
    fetchWindowIcons: true,
  });
  ultimaListagem = new Map(fontes.map((f) => [f.id, f]));
  // A própria janela do Tela: transmiti-la é um espelho infinito.
  const excluir = new Set<string>();
  if (janela !== null && !janela.isDestroyed()) excluir.add(janela.getMediaSourceId());
  return mapearFontes(
    fontes.map((f) => ({
      id: f.id,
      name: f.name,
      miniatura: imagemEmDataUrl(f.thumbnail, 'jpeg'),
      // O tipo diz `NativeImage`, mas para telas chega `null`.
      icone: imagemEmDataUrl(f.appIcon as NativeImage | null, 'png'),
    })),
    excluir,
  );
}

function configurarPermissoes(): void {
  const sessao = session.defaultSession;
  sessao.setPermissionRequestHandler((_conteudo, permissao, responder, detalhes) => {
    responder(permissaoConcedida(permissao, detalhes.requestingUrl, ORIGENS));
  });
  sessao.setPermissionCheckHandler((_conteudo, permissao, _origem, detalhes) =>
    permissaoConcedida(permissao, detalhes.requestingUrl, ORIGENS),
  );

  /*
    Captura de tela (D2). Com o seletor próprio (Windows, Linux X11) a página
    já escolheu por `escolherFonte`; aqui a escolha é consumida UMA vez e, sem
    ela, a resposta vazia vira `NotAllowedError` na página — DENIED, cancelar.
    No Wayland não há escolha prévia: o `getSources` abre o portal do sistema,
    que pergunta à pessoa e devolve uma fonte só.
  */
  sessao.setDisplayMediaRequestHandler((pedido, responder) => {
    if (!origemPermitida(pedido.securityOrigin, ORIGENS) && !origemPermitida(pedido.frame?.url, ORIGENS)) {
      responder({});
      return;
    }
    if (SELETOR_PROPRIO) {
      const escolha = escolhaPendente;
      escolhaPendente = null;
      const resposta = respostaDeCaptura(escolha, process.platform, pedido.audioRequested);
      responder(resposta === null ? {} : resposta);
      return;
    }
    void desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).then(
      (fontes) => {
        const [fonte] = fontes;
        responder(fonte === undefined ? {} : { video: fonte });
      },
      (erro: unknown) => {
        console.error('[tela] captura de tela indisponível:', erro);
        responder({});
      },
    );
  });
}

/* ------------------------------------------------- captura: tela-captura */

function spawnDoHelper(args: readonly string[]): ProcessoFilho {
  if (CAMINHO_DO_HELPER === null || !existeArquivo(CAMINHO_DO_HELPER)) throw new Error('tela-captura ausente');
  // stderr vai ao terminal do app: é onde o GStreamer explica o que falhou.
  return spawn(CAMINHO_DO_HELPER, args, { stdio: ['pipe', 'pipe', 'inherit'] });
}

const agendar = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

const capturaNativa = new CapturaNativa({ spawn: spawnDoHelper, agendar });

let capacidades = { nvenc: false, nvencDetalhe: 'SEM_HELPER', seletorProprio: SELETOR_PROPRIO };

async function sondarCapacidades(): Promise<void> {
  if (CAMINHO_DO_HELPER === null) {
    capacidades = { ...capacidades, nvencDetalhe: process.platform === 'win32' ? 'WINDOWS' : 'PLATAFORMA' };
    return;
  }
  /*
    `TELA_NATIVO=0` desliga o caminho nativo: o e2e do app vai ao ar com
    captura sintética, e o portal do Wayland (que só uma pessoa clica) não
    pode abrir no meio dele. Também serve para comparar NVENC × WebCodecs.
  */
  if (process.env['TELA_NATIVO'] === '0') {
    capacidades = { ...capacidades, nvencDetalhe: 'DESLIGADO' };
    return;
  }
  const sonda = await sondarNvenc({ spawn: spawnDoHelper, agendar });
  capacidades = { ...capacidades, nvenc: sonda.nvenc, nvencDetalhe: sonda.detalhe };
  console.warn(`[tela] NVENC: ${sonda.nvenc ? 'sim' : 'não'} (${sonda.detalhe})`);
}

function lerToken(): string | null {
  try {
    return lerTokenDoPortal(readFileSync(ARQUIVO_DO_TOKEN, 'utf8'));
  } catch {
    return null;
  }
}

function guardarToken(token: string | null): void {
  if (token === null) return;
  try {
    writeFileSync(ARQUIVO_DO_TOKEN, serializarTokenDoPortal(token), 'utf8');
  } catch (erro: unknown) {
    console.error('[tela] não deu para guardar o token do portal:', erro);
  }
}

/** As portas abertas por sessão, para fechar quando o processo morre. */
const portas = new Map<number, MessagePortMain>();

function fecharPorta(id: number): void {
  portas.get(id)?.close();
  portas.delete(id);
}

/**
 * Sobe o `tela-captura` e liga a saída dele à página por uma `MessagePort`:
 * quadros e eventos vão por ela (transferidos, sem cópia), ordens voltam por
 * ela. O `pronto` já está na fila da porta quando ela é entregue — a porta
 * carrega o que foi postado antes da transferência —, então o codificador da
 * página recebe o tamanho da fonte antes de ser iniciado.
 */
async function iniciarCapturaNativa(conteudo: WebContents, payload: unknown) {
  const pedido = pedidoDeCapturaValido(payload);
  if (pedido === null || !capacidades.nvenc) return { ok: false, erro: 'INDISPONIVEL' } as const;

  const { port1, port2 } = new MessageChannelMain();
  let idDaSessao: number | null = null;
  port1.on('message', (m) => {
    const dados = m.data as { tipo?: unknown; linha?: unknown } | null;
    const linha = ordemValida(dados?.tipo === 'ordem' ? dados.linha : null);
    if (linha !== null && idDaSessao !== null) capturaNativa.ordem(idDaSessao, linha);
  });
  port1.start();

  const resultado = await capturaNativa.iniciar(pedido, lerToken(), {
    quadro: (q) => port1.postMessage({ tipo: 'quadro', chave: q.chave, width: q.width, height: q.height, dados: q.dados }),
    captura: () => port1.postMessage({ tipo: 'captura' }),
    evento: (e) => port1.postMessage({ tipo: 'evento', evento: e }),
    encerrou: (fim) => {
      fecharPorta(fim.id);
      if (!conteudo.isDestroyed()) conteudo.send(CANAIS.capturaNativaEncerrou, fim);
    },
  });

  if (!resultado.ok || conteudo.isDestroyed()) {
    if (resultado.ok) capturaNativa.parar(resultado.value.id);
    port1.close();
    port2.close();
    return { ok: false, erro: resultado.ok ? 'MORREU' : resultado.error } as const;
  }
  const { id, fonte, memoria, restaurar } = resultado.value;
  idDaSessao = id;
  portas.set(id, port1);
  conteudo.postMessage(CANAIS.capturaNativaPorta, { id }, [port2]);
  guardarToken(restaurar);
  return { ok: true, id, fonte, memoria } as const;
}

/* ---------------------------------------------------------------- IPC */

function registrarIpc(): void {
  ipcMain.on(CANAIS.abrirNoNavegador, (evento, url: unknown) => {
    const permitida = urlParaAbrirNoNavegador(evento.senderFrame?.url, url, ORIGENS);
    if (permitida !== null) void shell.openExternal(permitida);
  });

  // Todo `invoke` vem de um frame da interface, ou não vem: o payload não prova nada.
  const daInterface = (evento: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    origemPermitida(evento.senderFrame?.url, ORIGENS);

  ipcMain.handle(CANAIS.capacidades, (evento) => (daInterface(evento) ? capacidades : null));

  ipcMain.handle(CANAIS.listarFontes, async (evento) => {
    if (!daInterface(evento) || !SELETOR_PROPRIO) return [];
    try {
      return await listarFontes();
    } catch (erro: unknown) {
      console.error('[tela] listar fontes falhou:', erro);
      return [];
    }
  });

  ipcMain.handle(CANAIS.escolherFonte, (evento, payload: unknown) => {
    if (!daInterface(evento)) return false;
    const escolha = escolhaValida(payload, ultimaListagem);
    if (escolha === null) return false;
    if (escolha.id === null) {
      escolhaPendente = null;
      return true;
    }
    const fonte = ultimaListagem.get(escolha.id);
    const tipo = tipoDaFonte(escolha.id);
    if (fonte === undefined || tipo === null) return false;
    escolhaPendente = { fonte, tipo };
    // A listagem com as miniaturas já cumpriu o papel: só a escolhida fica.
    ultimaListagem = new Map([[escolha.id, fonte]]);
    return true;
  });

  ipcMain.handle(CANAIS.capturaNativaIniciar, (evento, payload: unknown) =>
    daInterface(evento) ? iniciarCapturaNativa(evento.sender, payload) : { ok: false, erro: 'INDISPONIVEL' },
  );

  ipcMain.on(CANAIS.capturaNativaParar, (evento, id: unknown) => {
    if (!daInterface(evento) || typeof id !== 'number') return;
    capturaNativa.parar(id);
    fecharPorta(id);
  });
}

// Uma instância só: a segunda chamada traz a janela que já existe.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', mostrarJanela);

  // O menu padrão do Electron (File/Edit/View…) não é do Tela.
  Menu.setApplicationMenu(null);

  app.on('web-contents-created', (_evento, conteudo) => blindar(conteudo));

  app.whenReady().then(() => {
    registrarProtocoloApp();
    configurarPermissoes();
    registrarIpc();
    janela = criarJanela();
    // Em paralelo com a janela: a sonda leva até alguns segundos quando o
    // driver acorda a GPU, e a tela inicial não depende dela.
    void sondarCapacidades();

    // macOS: clicar no dock sem janela aberta reabre.
    app.on('activate', mostrarJanela);
  }, (erro: unknown) => {
    console.error('[tela] falha ao iniciar:', erro);
    app.exit(1);
  });

  // D4 muda isto: fechar ao vivo esconde (bandeja ou modo compacto, §5). No D1
  // fechar a janela encerra o app, em todas as plataformas.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => capturaNativa.pararTudo());
}
