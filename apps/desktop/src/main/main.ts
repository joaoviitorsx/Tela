/**
 * O processo principal do Tela Desktop — D1, a casca (PLANO-desktop §3).
 *
 * Uma janela, que carrega a interface do site de `app://tela/` (o build de
 * `apps/web` para desktop) e fica quase ociosa: avisa a página quando a janela
 * some, abre links no navegador do sistema e entrega a captura de tela. A
 * transmissão inteira vive no renderer, com o `core/` intacto.
 *
 * Em desenvolvimento, `TELA_DESKTOP_URL` aponta para o Vite
 * (`scripts/dev.mjs`); sem ela, o `app://` serve `apps/web/dist-desktop`.
 */
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
  type WebContents,
} from 'electron';
import { ESQUEMA_APP, ORIGEM_APP, PAGINA_UNICA, resolverArquivo } from './protocolo-app.js';
import {
  decidirJanelaNova,
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

const URL_DE_DESENVOLVIMENTO = process.env['TELA_DESKTOP_URL'];
const ORIGENS = origensPermitidas(URL_DE_DESENVOLVIMENTO);
const URL_INICIAL = URL_DE_DESENVOLVIMENTO ?? `${ORIGEM_APP}/${PAGINA_UNICA}`;

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
    // ora só registra: nunca fingir continuidade.
    console.error(`[tela] renderer caiu: ${detalhes.reason} (código ${detalhes.exitCode})`);
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

function configurarPermissoes(): void {
  const sessao = session.defaultSession;
  sessao.setPermissionRequestHandler((_conteudo, permissao, responder, detalhes) => {
    responder(permissaoConcedida(permissao, detalhes.requestingUrl, ORIGENS));
  });
  sessao.setPermissionCheckHandler((_conteudo, permissao, _origem, detalhes) =>
    permissaoConcedida(permissao, detalhes.requestingUrl, ORIGENS),
  );

  /*
    Captura de tela, versão mínima do D1: a primeira tela inteira, sem
    escolha. O D2 troca isto pelo seletor próprio (miniaturas de janelas e telas
    no Windows; no Linux, Wayland, o `desktopCapturer` já passa pelo portal
    xdg-desktop-portal, que mostra o diálogo do sistema para a pessoa escolher).
    Áudio `loopback` (o som do sistema) só existe no Windows; nas outras
    plataformas a sessão segue o caminho de áudio de hoje.
  */
  sessao.setDisplayMediaRequestHandler((pedido, responder) => {
    void desktopCapturer.getSources({ types: ['screen'] }).then(
      (fontes) => {
        const [fonte] = fontes;
        if (fonte === undefined) {
          responder({});
          return;
        }
        responder(
          process.platform === 'win32' && pedido.audioRequested
            ? { video: fonte, audio: 'loopback' }
            : { video: fonte },
        );
      },
      (erro: unknown) => {
        console.error('[tela] captura de tela indisponível:', erro);
        responder({});
      },
    );
  });
}

function registrarIpc(): void {
  ipcMain.on(CANAIS.abrirNoNavegador, (evento, url: unknown) => {
    const permitida = urlParaAbrirNoNavegador(evento.senderFrame?.url, url, ORIGENS);
    if (permitida !== null) void shell.openExternal(permitida);
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

    // macOS: clicar no dock sem janela aberta reabre.
    app.on('activate', mostrarJanela);
  }, (erro: unknown) => {
    console.error('[tela] falha ao iniciar:', erro);
    app.exit(1);
  });

  // D4 muda isto: fechar ao vivo esconde (bandeja ou modo compacto, §5). No D1
  // fechar a janela encerra o app, em todas as plataformas.
  app.on('window-all-closed', () => app.quit());
}
