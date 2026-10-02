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
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  type DesktopCapturerSource,
  ipcMain,
  Menu,
  MessageChannelMain,
  type MessagePortMain,
  type NativeImage,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
  Tray,
  type WebContents,
} from 'electron';
import {
  type Ajustes,
  AJUSTES_PADRAO,
  lerAjustes,
  mesclarAjustes,
  mesmosAjustes,
  serializarAjustes,
} from './ajustes.js';
import {
  ARGUMENTO_OCULTO,
  conteudoDoAutostart,
  executavelDoAutostart,
  iniciaOculto,
  NOME_DO_ARQUIVO_AUTOSTART,
  pastaDoAutostart,
} from './autostart.js';
import {
  bandejaForcada,
  COMANDO_DA_SONDA,
  monocromaAmbar,
  plataformaTemBandeja,
  watcherPresenteNaSaida,
} from './bandeja.js';
import {
  estadoAoVivoValido,
  FORA_DO_AR,
  type EstadoAoVivo,
  mesmoEstado,
  modeloDoMenu,
  rotuloDoEstado,
} from './estado-ao-vivo.js';
import { criarPortaoDeParada, type PortaoDeParada } from './parada.js';
import { pedidoDeJogoValido } from './som/protocolo-som.js';
import { criarSomDoApp } from './som/som-do-app.js';
import {
  type DecisaoDeFechar,
  decidirFechar,
  escolhaParaLembrar,
  MINIMO_NORMAL,
  modoValido,
  type ModoDaJanela,
  motivoDeQueda,
  registrarQueda,
  respostaDeFecharValida,
  TAMANHO_COMPACTO,
  urlDaRecuperacao,
} from './politica-de-fechar.js';
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
import {
  argumentosDoRegistro,
  canalDoArgv,
  canalDoLinkProfundo,
  deveRegistrarEsquema,
  ESQUEMA_LINK,
} from './link-profundo.js';
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
  somCapacidades: 'tela:som-capacidades',
  somListarApps: 'tela:som-listar-apps',
  somIniciarJogo: 'tela:som-iniciar-jogo',
  somParar: 'tela:som-parar',
  somIniciarSistema: 'tela:som-iniciar-sistema',
  somJogoEncerrou: 'tela:som-jogo-encerrou',
  somJogoPorta: 'tela:som-jogo-porta',
  /** main → renderer, `string` (slug já validado) */
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
} as const;

/*
  `TELA_USERDATA` põe os dados do app (ajustes, token do portal, autostart) numa
  pasta à parte — o e2e roda sem tocar os da pessoa, e a trava de instância
  única, que mora em `userData`, deixa de brigar com o app que ela já tem aberto.
  Tem de vir ANTES de qualquer `app.getPath('userData')`.
*/
const USERDATA_PORTATIL = process.env['TELA_USERDATA'];
if (USERDATA_PORTATIL !== undefined && USERDATA_PORTATIL !== '') app.setPath('userData', USERDATA_PORTATIL);

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

/** Onde ficam os ajustes (D4). */
const ARQUIVO_DE_AJUSTES = join(app.getPath('userData'), 'ajustes.json');
/** O ícone da bandeja: empacotado vai em `resources/icon.png`. */
const ARQUIVO_DO_ICONE = app.isPackaged ? resolve(process.resourcesPath, 'icon.png') : resolve(AQUI, '../../build/icon.png');

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
  // Renderer caído: não há quadro para receber, e o Electron registra erro ao tentar.
  if (!j.isDestroyed() && !j.webContents.isCrashed()) j.webContents.send(CANAIS.visibilidade, valor);
}

function criarJanela(): BrowserWindow {
  paginaPronta = false;
  const j = new BrowserWindow({
    title: 'Tela',
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    // Tela cheia do espectador (F, duplo clique): o `requestFullscreen` da
    // página precisa de uma janela que possa ir para tela cheia. É o padrão do
    // Electron; fica escrito porque o D8 depende dele. O `Esc` sai sozinho.
    fullscreenable: true,
    backgroundColor: '#000000',
    // Aparece pronta: sem o flash branco antes do primeiro quadro da página.
    // Aberto pelo autostart, só aparece se não houver bandeja para controlá-lo.
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

  j.once('ready-to-show', () => {
    void bandejaPronta.then(() => {
      if (!j.isDestroyed() && !(INICIO_OCULTO && temBandeja)) j.show();
    });
  });

  // Visibilidade (§3.2): a página pausa animação e prévia quando some.
  j.on('minimize', () => avisarVisibilidade(j, false));
  j.on('hide', () => {
    avisarVisibilidade(j, false);
    atualizarBandeja();
  });
  j.on('restore', () => avisarVisibilidade(j, true));
  j.on('show', () => {
    avisarVisibilidade(j, true);
    atualizarBandeja();
  });
  j.on('close', (evento) => aoFecharJanela(evento));
  // Ao carregar, a página recebe o estado atual — pode ter nascido minimizada.
  j.webContents.on('did-finish-load', () => {
    avisarVisibilidade(j, visivel(j));
    // O modo também: a janela pode ter recarregado (queda) enquanto compacta.
    j.webContents.send(CANAIS.modo, modo);
    // Página nova = nada no ar ainda. A página só conta o "fora do ar" inicial
    // por omissão, então o que o main guardava de antes não vale mais.
    if (estado.noAr) {
      estado = FORA_DO_AR;
      atualizarBandeja();
      if (modo === 'compacto') definirModo('normal');
    }
    paginaPronta = true;
    // Um link que chegou antes da página existir (lançamento a frio pelo link).
    if (canalPendente !== null) {
      const slug = canalPendente;
      canalPendente = null;
      j.webContents.send(CANAIS.abrirCanal, slug);
    }
  });

  j.webContents.on('render-process-gone', (_evento, detalhes) => aoCairORenderer(j, detalhes.reason, detalhes.exitCode));

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

/* ------------------------------------------- segundo plano (D4, §5) */

const INICIO_OCULTO = iniciaOculto(process.argv);

let ajustes: Ajustes = AJUSTES_PADRAO;
let estado: EstadoAoVivo = FORA_DO_AR;
let modo: ModoDaJanela = 'normal';
/** A geometria do modo normal, para o "expandir" devolvê-la. */
let geometriaNormal: Electron.Rectangle | null = null;
let tray: Tray | null = null;
let temBandeja = false;
/** `true` assim que o app decidiu sair: o `close` e o `before-quit` deixam passar. */
let saindo = false;
let encerrando = false;
/** Há um "Continuar em segundo plano?" esperando resposta da página. */
let perguntando = false;
let portaoDeParada: PortaoDeParada | null = null;
let suspensaoPendente = false;
let quedas: readonly number[] = [];
let tiqueDaBandeja: ReturnType<typeof setInterval> | null = null;
let rotuloDaBandeja = '';

function lerAjustesDoDisco(): Ajustes {
  try {
    return lerAjustes(readFileSync(ARQUIVO_DE_AJUSTES, 'utf8'));
  } catch {
    return AJUSTES_PADRAO;
  }
}

function gravarAjustes(): void {
  try {
    writeFileSync(ARQUIVO_DE_AJUSTES, serializarAjustes(ajustes), 'utf8');
  } catch (erro: unknown) {
    console.error('[tela] não deu para gravar os ajustes:', erro);
  }
}

/**
 * Liga ou desliga o "iniciar com o sistema". `false` quando não deu — o ajuste
 * então volta ao valor anterior, em vez de mostrar uma caixa marcada que não
 * vale. Com `TELA_USERDATA` (e2e) o Windows nunca mexe no registro e o Linux
 * escreve na pasta temporária.
 */
function aplicarAutostart(ligado: boolean): boolean {
  try {
    const portatil = USERDATA_PORTATIL !== undefined && USERDATA_PORTATIL !== '';
    if (process.platform === 'linux') {
      // Fora do pacote o executável seria o do Electron solto: um autostart quebrado.
      if (ligado && !app.isPackaged && !portatil && (process.env['XDG_CONFIG_HOME'] ?? '') === '') return false;
      const pasta = pastaDoAutostart(process.env, homedir());
      const arquivo = join(pasta, NOME_DO_ARQUIVO_AUTOSTART);
      if (!ligado) {
        rmSync(arquivo, { force: true });
        return true;
      }
      mkdirSync(pasta, { recursive: true });
      const comando = app.isPackaged
        ? [executavelDoAutostart(process.env, process.execPath)]
        : [process.execPath, app.getAppPath()];
      writeFileSync(arquivo, conteudoDoAutostart(comando), 'utf8');
      return true;
    }
    if (portatil || !app.isPackaged) return !ligado || portatil;
    app.setLoginItemSettings({ openAtLogin: ligado, args: [ARGUMENTO_OCULTO] });
    return true;
  } catch (erro: unknown) {
    console.error('[tela] autostart falhou:', erro);
    return false;
  }
}

/* ------------------------------------------------------------ bandeja */

function sondarBandeja(): Promise<boolean> {
  const forcada = bandejaForcada(process.env);
  if (forcada !== null) return Promise.resolve(forcada);
  const plataforma = plataformaTemBandeja(process.platform);
  if (plataforma !== 'sondar') return Promise.resolve(plataforma);
  return new Promise((resolver) => {
    execFile(COMANDO_DA_SONDA.arquivo, [...COMANDO_DA_SONDA.args], { timeout: 1500 }, (erro, saida) => {
      // Sem `dbus-send` ou sem resposta: na dúvida, não há bandeja — o app cai
      // no compacto, que é seguro; esconder numa bandeja que não existe, não.
      resolver(erro === null && watcherPresenteNaSaida(saida));
    });
  });
}

function iconeDaBandeja(): NativeImage {
  const lado = process.platform === 'win32' ? 32 : 24;
  const original = nativeImage.createFromPath(ARQUIVO_DO_ICONE);
  if (original.isEmpty()) return original;
  const pequeno = original.resize({ width: lado, height: lado, quality: 'best' });
  const { width, height } = pequeno.getSize();
  return nativeImage.createFromBitmap(Buffer.from(monocromaAmbar(pequeno.toBitmap())), { width, height });
}

function janelaVisivelAgora(): boolean {
  return janela !== null && !janela.isDestroyed() && visivel(janela);
}

function alternarJanela(): void {
  if (janelaVisivelAgora() && janela !== null) janela.hide();
  else mostrarJanela();
}

function aoEscolherNoMenu(id: string): void {
  switch (id) {
    case 'copiar':
      if (estado.link !== null) clipboard.writeText(estado.link);
      break;
    case 'mostrar':
      alternarJanela();
      break;
    case 'encerrar':
      // O fluxo de encerrar é o da interface, com a confirmação de quem
      // assiste: a janela aparece para a pergunta ser vista.
      if (janela !== null && !janela.isDestroyed()) {
        mostrarJanela();
        janela.webContents.send(CANAIS.pedirEncerrar);
      }
      break;
    case 'sair':
      void sairEncerrando();
      break;
  }
}

/** Texto e menu da bandeja. Só reescreve o que mudou: o D-Bus não precisa de ruído. */
function atualizarBandeja(): void {
  if (tray === null) return;
  const agora = Date.now();
  const visivelAgora = janelaVisivelAgora();
  const modelo = modeloDoMenu(estado, visivelAgora, agora);
  const chave = JSON.stringify(modelo);
  if (chave === rotuloDaBandeja) return;
  rotuloDaBandeja = chave;
  tray.setToolTip(`Tela — ${rotuloDoEstado(estado, agora)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate(
      modelo.map((item) =>
        item.tipo === 'separador'
          ? { type: 'separator' as const }
          : { label: item.rotulo, enabled: item.habilitado, click: () => aoEscolherNoMenu(item.id) },
      ),
    ),
  );
}

function iniciarBandeja(): Promise<void> {
  return sondarBandeja().then((tem) => {
    if (!tem) return;
    try {
      tray = new Tray(iconeDaBandeja());
      // Windows: o clique esquerdo alterna a janela; no Linux o ícone abre o menu.
      tray.on('click', alternarJanela);
      temBandeja = true;
      atualizarBandeja();
    } catch (erro: unknown) {
      console.error('[tela] bandeja indisponível:', erro);
      tray = null;
    }
  });
}

/** A bandeja existe? Resolve depois da sonda; a janela espera por ela para decidir se nasce oculta. */
let resolverBandeja: () => void = () => undefined;
const bandejaPronta: Promise<void> = new Promise((resolver) => {
  resolverBandeja = resolver;
});

/* ------------------------------------------------------ modo compacto */

function definirModo(novo: ModoDaJanela): void {
  const j = janela;
  if (j === null || j.isDestroyed()) return;
  if (novo !== modo) {
    if (novo === 'compacto') {
      if (j.isFullScreen()) j.setFullScreen(false);
      if (j.isMaximized()) j.unmaximize();
      geometriaNormal = j.getBounds();
      // O tamanho ANTES de travar: em vários gerenciadores do Linux uma janela
      // não redimensionável ignora `setSize`.
      j.setMinimumSize(TAMANHO_COMPACTO.width, TAMANHO_COMPACTO.height);
      j.setSize(TAMANHO_COMPACTO.width, TAMANHO_COMPACTO.height);
      j.setResizable(false);
      j.setAlwaysOnTop(ajustes.sempreNoTopoNoCompacto, 'floating');
    } else {
      j.setAlwaysOnTop(false);
      j.setResizable(true);
      j.setMinimumSize(MINIMO_NORMAL.width, MINIMO_NORMAL.height);
      if (geometriaNormal !== null) j.setBounds(geometriaNormal);
      else j.setSize(1280, 800);
      geometriaNormal = null;
    }
    modo = novo;
  }
  if (!j.webContents.isCrashed()) j.webContents.send(CANAIS.modo, modo);
}

/* ------------------------------------------------- fechar, sair, parar */

function decisaoDeFechar(): DecisaoDeFechar {
  return decidirFechar({
    noAr: estado.noAr,
    aoFecharAoVivo: ajustes.aoFecharAoVivo,
    fecharEmSegundoPlano: ajustes.fecharEmSegundoPlano,
    temBandeja,
    modoCompacto: modo === 'compacto',
  });
}

function executarDecisao(decisao: DecisaoDeFechar): void {
  const j = janela;
  if (j === null || j.isDestroyed()) return;
  switch (decisao) {
    case 'esconder':
      j.hide();
      break;
    case 'compacto':
      definirModo('compacto');
      break;
    case 'minimizar':
      j.minimize();
      break;
    case 'perguntar':
      // Sempre reenvia: a página pode ter perdido a pergunta (recarregou).
      perguntando = true;
      j.webContents.send(CANAIS.perguntarFechar);
      break;
    case 'encerrar-e-sair':
      void sairEncerrando();
      break;
    case 'sair':
      break;
  }
}

function aoFecharJanela(evento: Electron.Event): void {
  if (saindo) return;
  const decisao = decisaoDeFechar();
  // Fora do ar e sem "fechar = segundo plano": deixa o `close` seguir e o app sai.
  if (decisao === 'sair') return;
  evento.preventDefault();
  executarDecisao(decisao);
}

/**
 * Sair com a transmissão no ar: a página roda `stop()` (libera trilhas e peers
 * e avisa a sala) e confirma; com prazo, para um renderer travado não prender
 * o app. Só então o app sai.
 */
async function sairEncerrando(): Promise<void> {
  if (saindo || encerrando) return;
  encerrando = true;
  const j = janela;
  if (estado.noAr && j !== null && !j.isDestroyed()) {
    portaoDeParada = criarPortaoDeParada(agendar);
    const espera = portaoDeParada.aguardar();
    j.webContents.send(CANAIS.parar, 'sair');
    await espera;
  }
  saindo = true;
  capturaNativa.pararTudo();
  app.quit();
}

function aoCairORenderer(j: BrowserWindow, razao: string, codigo: number): void {
  // Saída limpa (código 0) não é queda.
  if (razao === 'clean-exit') return;
  console.error(`[tela] renderer caiu: ${razao} (código ${codigo})`);
  // O `tela-captura` não pode ficar codificando para ninguém, e o estado
  // "no ar" que o main guardava já não é verdade.
  capturaNativa.pararTudo();
  // O som do jogo também: o sink do Tela e o roteamento do app não podem
  // sobreviver à página que os pediu.
  void somDoApp.parar();
  const estavaNoAr = estado.noAr;
  estado = FORA_DO_AR;
  perguntando = false;
  portaoDeParada?.confirmar();
  atualizarBandeja();
  if (modo === 'compacto') definirModo('normal');
  const registro = registrarQueda(quedas, Date.now());
  quedas = registro.quedas;
  // Em laço (a própria página de recuperação caindo): não insiste.
  if (!registro.recarregar || j.isDestroyed()) return;
  mostrarJanela();
  paginaPronta = false;
  void j.loadURL(urlDaRecuperacao(URL_INICIAL, motivoDeQueda(razao), estavaNoAr));
}

function registrarEnergia(): void {
  powerMonitor.on('suspend', () => {
    // Não dá para segurar a suspensão: encerra e deixa o motivo para a volta.
    if (!estado.noAr || janela === null || janela.isDestroyed()) return;
    suspensaoPendente = true;
    janela.webContents.send(CANAIS.parar, 'suspensao');
  });
  powerMonitor.on('resume', () => {
    if (!suspensaoPendente) return;
    suspensaoPendente = false;
    capturaNativa.pararTudo();
    // A página pode ter congelado antes de ouvir o primeiro aviso: repete, e
    // é ela quem mostra o motivo a quem volta.
    if (janela !== null && !janela.isDestroyed()) janela.webContents.send(CANAIS.parar, 'suspensao');
  });
}

/* ------------------------------------------------- link profundo (D8) */

/**
 * O canal que chegou por `tela://assistir/<slug>` e ainda não pôde ser
 * entregue: o app abriu PELO link, e a página só existe depois do load.
 */
let canalPendente: string | null = null;
let paginaPronta = false;

/**
 * Entrega um canal já validado ao renderer e traz a janela. O main NÃO decide
 * se pode navegar: quem sabe que a pessoa está ao vivo é a rota
 * (`/transmitir`), e é ela quem recusa. O link só abre canal — nunca captura.
 */
function abrirCanal(slug: string): void {
  if (!app.isReady()) {
    canalPendente = slug;
    return;
  }
  canalPendente = slug;
  mostrarJanela();
  if (janela !== null && !janela.isDestroyed() && paginaPronta && !janela.webContents.isLoading()) {
    canalPendente = null;
    janela.webContents.send(CANAIS.abrirCanal, slug);
  }
}

function registrarEsquema(): void {
  if (!deveRegistrarEsquema(app.isPackaged, process.env)) return;
  const args = argumentosDoRegistro(process.defaultApp === true, process.argv, (c) => resolve(c));
  if (args === null && process.defaultApp === true) return;
  const registrou =
    args === null
      ? app.setAsDefaultProtocolClient(ESQUEMA_LINK)
      : app.setAsDefaultProtocolClient(ESQUEMA_LINK, process.execPath, [...args]);
  if (!registrou) console.error('[tela] não foi possível registrar o esquema tela://');
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

/**
 * O som do jogo (D3, `docs/desktop/D3-som.md`): "só o jogo" no Linux (PipeWire,
 * sink próprio) e no Windows (addon WASAPI num utility process). "Sistema" e
 * "sem som" não passam por aqui.
 */
const somDoApp = criarSomDoApp({
  pastaDoMain: AQUI,
  canalDaPorta: CANAIS.somJogoPorta,
  avisarEncerrou: (conteudo, fim) => conteudo.send(CANAIS.somJogoEncerrou, fim),
});
let saindoDoSom = false;

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

  /* ---- D4: segundo plano */

  ipcMain.on(CANAIS.estadoAoVivo, (evento, payload: unknown) => {
    if (!daInterface(evento)) return;
    const novo = estadoAoVivoValido(payload);
    if (novo === null || mesmoEstado(novo, estado)) return;
    const eraNoAr = estado.noAr;
    estado = novo;
    if (eraNoAr && !novo.noAr) {
      portaoDeParada?.confirmar();
      // Acabou a transmissão: o compacto não tem mais o que mostrar.
      if (modo === 'compacto') definirModo('normal');
    }
    if (novo.noAr && tiqueDaBandeja === null) {
      // O tempo no menu anda a cada 10 s: a bandeja não precisa de segundos.
      tiqueDaBandeja = setInterval(atualizarBandeja, 10_000);
    } else if (!novo.noAr && tiqueDaBandeja !== null) {
      clearInterval(tiqueDaBandeja);
      tiqueDaBandeja = null;
    }
    atualizarBandeja();
  });

  const respostaDeAjustes = (autostartFalhou: boolean) => ({ ajustes, bandeja: temBandeja, autostartFalhou });

  ipcMain.handle(CANAIS.ajustes, (evento) => (daInterface(evento) ? respostaDeAjustes(false) : null));

  ipcMain.handle(CANAIS.salvarAjustes, (evento, payload: unknown) => {
    if (!daInterface(evento)) return null;
    let novo = mesclarAjustes(ajustes, payload);
    let falhou = false;
    if (novo.iniciarComSistema !== ajustes.iniciarComSistema && !aplicarAutostart(novo.iniciarComSistema)) {
      falhou = true;
      novo = { ...novo, iniciarComSistema: ajustes.iniciarComSistema };
    }
    if (!mesmosAjustes(novo, ajustes)) {
      ajustes = novo;
      gravarAjustes();
      if (modo === 'compacto' && janela !== null && !janela.isDestroyed()) {
        janela.setAlwaysOnTop(ajustes.sempreNoTopoNoCompacto, 'floating');
      }
    }
    return respostaDeAjustes(falhou);
  });

  ipcMain.on(CANAIS.pedirModo, (evento, valor: unknown) => {
    if (!daInterface(evento)) return;
    const pedido = modoValido(valor);
    // Compacto só ao vivo: sem transmissão não há o que mostrar nele.
    if (pedido === null || (pedido === 'compacto' && !estado.noAr)) return;
    definirModo(pedido);
  });

  ipcMain.on(CANAIS.responderFechar, (evento, payload: unknown) => {
    if (!daInterface(evento) || !perguntando) return;
    const resposta = respostaDeFecharValida(payload);
    if (resposta === null) return;
    perguntando = false;
    const lembrada = escolhaParaLembrar(resposta);
    if (lembrada !== null && lembrada !== ajustes.aoFecharAoVivo) {
      ajustes = { ...ajustes, aoFecharAoVivo: lembrada };
      gravarAjustes();
    }
    if (resposta.acao === 'segundo-plano') {
      executarDecisao(temBandeja ? 'esconder' : 'compacto');
    } else if (resposta.acao === 'encerrar') {
      void sairEncerrando();
    }
  });

  ipcMain.on(CANAIS.paradaConcluida, (evento) => {
    if (daInterface(evento)) portaoDeParada?.confirmar();
  });

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

  ipcMain.handle(CANAIS.somCapacidades, (evento) => (daInterface(evento) ? somDoApp.capacidades() : null));

  ipcMain.handle(CANAIS.somListarApps, async (evento) => {
    if (!daInterface(evento)) return [];
    try {
      return await somDoApp.listarApps();
    } catch (erro: unknown) {
      console.error('[tela] listar apps com som falhou:', erro);
      return [];
    }
  });

  ipcMain.handle(CANAIS.somIniciarJogo, async (evento, payload: unknown) => {
    if (!daInterface(evento) || pedidoDeJogoValido(payload) === null) return { ok: false, erro: 'APP_NAO_ENCONTRADO' };
    try {
      return await somDoApp.iniciarJogo(evento.sender, payload);
    } catch (erro: unknown) {
      console.error('[tela] som do jogo falhou:', erro);
      await somDoApp.parar();
      return { ok: false, erro: 'FALHOU' };
    }
  });

  ipcMain.on(CANAIS.somParar, (evento) => {
    if (daInterface(evento)) void somDoApp.parar();
  });

  ipcMain.handle(CANAIS.somIniciarSistema, (evento) =>
    daInterface(evento) ? somDoApp.iniciarSistema(evento.sender) : { ok: false, erro: 'INDISPONIVEL' },
  );

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
  app.on('second-instance', (_evento, argv) => {
    // Um autostart que chega com o app já aberto não traz janela nenhuma.
    if (iniciaOculto(argv) && canalDoArgv(argv) === null) return;
    const slug = canalDoArgv(argv);
    if (slug === null) mostrarJanela();
    else abrirCanal(slug);
  });

  // macOS entrega o esquema por evento, e pode ser antes do `ready`.
  app.on('open-url', (evento, url) => {
    evento.preventDefault();
    const slug = canalDoLinkProfundo(url);
    if (slug !== null) abrirCanal(slug);
  });

  // O menu padrão do Electron (File/Edit/View…) não é do Tela.
  Menu.setApplicationMenu(null);

  app.on('web-contents-created', (_evento, conteudo) => blindar(conteudo));

  app.whenReady().then(() => {
    registrarProtocoloApp();
    configurarPermissoes();
    registrarIpc();
    registrarEsquema();
    ajustes = lerAjustesDoDisco();
    // O caminho do executável pode ter mudado (AppImage movido, atualização).
    if (ajustes.iniciarComSistema) aplicarAutostart(true);
    registrarEnergia();
    void iniciarBandeja().finally(resolverBandeja);
    // Lançado pelo link (primeira instância): o canal espera a página carregar.
    canalPendente = canalPendente ?? canalDoArgv(process.argv);
    janela = criarJanela();
    // Em paralelo com a janela: a sonda leva até alguns segundos quando o
    // driver acorda a GPU, e a tela inicial não depende dela.
    void sondarCapacidades();
    // Resíduos de uma execução que caiu sem limpar (sink e roteamento do som do jogo).
    void somDoApp.limparResiduos();

    // macOS: clicar no dock sem janela aberta reabre.
    app.on('activate', mostrarJanela);
  }, (erro: unknown) => {
    console.error('[tela] falha ao iniciar:', erro);
    app.exit(1);
  });

  // Fechar ao vivo esconde ou vira compacto (`aoFecharJanela`); a janela só é
  // destruída quando a política decidiu sair — então, sem janelas, sai.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (evento) => {
    // Ctrl+Q, desligar o sistema, `app.quit()` de qualquer lugar: ao vivo, a
    // sessão para primeiro (`stop()` avisa a sala), e só depois sai.
    if (!saindo && estado.noAr && janela !== null && !janela.isDestroyed()) {
      evento.preventDefault();
      void sairEncerrando();
      return;
    }
    capturaNativa.pararTudo();
  });

  /*
    O roteamento do som do jogo é do sistema, não do app: sair sem devolvê-lo
    deixaria o jogo da pessoa apontando para um sink que some junto. O `quit`
    espera `parar()` (alguns `pw-metadata`, dezenas de ms) e só então sai.
  */
  app.on('will-quit', (evento) => {
    if (saindoDoSom || !somDoApp.ativo()) return;
    evento.preventDefault();
    saindoDoSom = true;
    void somDoApp.parar().finally(() => app.quit());
  });

  // Ctrl+C no terminal e `kill` normal: passam pelo mesmo caminho de sair.
  for (const sinal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sinal, () => app.quit());
}
