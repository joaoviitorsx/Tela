/**
 * O motor de atualização sobre o `electron-updater` — o ÚNICO arquivo do app
 * que o conhece (toda lib externa entra atrás de uma porta: `MotorDeAtualizacao`).
 *
 * `electron-updater` é dependência de RUNTIME de propósito: roda no main
 * empacotado, então o electron-builder o leva (e as dependências dele) para
 * dentro do `app.asar`. Nenhuma outra biblioteca de update serve ao NSIS e ao
 * AppImage de uma configuração só (`latest.yml`, `latest-linux.yml`, blockmap).
 *
 * Verificação de integridade: o updater confere o SHA-512 de cada arquivo
 * baixado contra o do `latest*.yml`. NÃO confere assinatura (Authenticode):
 * o instalador do Windows não é assinado (§15) e `publisherName` não está no
 * `electron-builder.yml`, então o `verifySignature` do NsisUpdater é pulado.
 * O `latest.yml` e o instalador vêm do mesmo release, por HTTPS; quem
 * controla o release controla os dois. O que protege o release é a atestação
 * de proveniência do CI, que cobre também os `latest*.yml` (docs/desktop/D5-atualizacao.md).
 */
import type { AppUpdater, CancellationToken } from 'electron-updater';
import type { MotorDeAtualizacao } from './atualizador.js';
import {
  ehMaisNova,
  type ModoDeAtualizacao,
  releaseMaisNovaDoTexto,
  urlDaPaginaDoRelease,
  urlDoFeed,
} from './atualizacao-release.js';
import { assinaturaConfere as assinaturaConfereNativa, urlDaAssinatura } from './verificacao-de-assinatura.js';

/** O recorte do módulo `electron-updater` que se usa (e que o teste substitui). */
export type ModuloDoUpdater = {
  readonly autoUpdater: AppUpdater;
  readonly CancellationToken: new () => CancellationToken;
};

export type DependenciasDoMotor = {
  readonly modo: ModoDeAtualizacao;
  readonly versaoAtual: string;
  /** GET da lista de releases (HTTPS, com prazo). Devolve o texto. */
  readonly buscarLista: () => Promise<string>;
  /** GET de um arquivo binário pequeno (a assinatura `.sig`), com prazo. `null` se falhar. */
  readonly baixarBinario: (url: string) => Promise<Uint8Array | null>;
  /** Lê do disco o instalador que o updater baixou. `null` se falhar. */
  readonly lerArquivo: (caminho: string) => Promise<Uint8Array | null>;
  /** Verifica a assinatura Ed25519 do instalador (ADR 0038). Injetável para teste. */
  readonly verificarAssinatura?: (conteudo: Uint8Array, assinatura: Uint8Array) => boolean;
  /** Carregamento preguiçoso: deb/rpm e o desenvolvimento nunca o carregam. */
  readonly carregarUpdater: () => Promise<ModuloDoUpdater>;
  /** Chamado ANTES de fechar para instalar: o main tem de deixar a janela sair (`saindo`). */
  readonly aoReiniciar: () => void;
  readonly log: { readonly info: (m: string) => void; readonly erro: (m: string, e?: unknown) => void };
};

export function criarMotorDoUpdater(deps: DependenciasDoMotor): MotorDeAtualizacao {
  let modulo: ModuloDoUpdater | null = null;
  let token: CancellationToken | null = null;
  let versaoAchada: string | null = null;
  /** O feed da release escolhida em `verificar()` — base das URLs de `.sig`. */
  let feedAtual: string | null = null;
  /**
   * A assinatura do instalador baixado foi conferida (ADR 0038). Começa `false`
   * e só vira `true` depois de `baixar()` verificar — é o que destrava o install.
   */
  let assinaturaVerificada = false;
  const verificarAssinatura = deps.verificarAssinatura ?? assinaturaConfereNativa;

  async function updater(): Promise<ModuloDoUpdater> {
    if (modulo !== null) return modulo;
    const m = await deps.carregarUpdater();
    const u = m.autoUpdater;
    // Quem decide quando baixar é a política (nunca ao vivo).
    u.autoDownload = false;
    // Começa DESLIGADO: nada se instala antes de `baixar()` conferir a assinatura
    // (ADR 0038). `instalarAoSair`/`instalarAgora` só ligam depois de verificada —
    // um instalador sem assinatura da chave do Tela nunca vira "instalar ao sair".
    u.autoInstallOnAppQuit = false;
    // Sem downgrade, e a versão atual é beta: pré-release é permitido por padrão.
    u.allowDowngrade = false;
    u.allowPrerelease = true;
    u.logger = {
      info: (m2) => deps.log.info(String(m2)),
      warn: (m2) => deps.log.info(String(m2)),
      error: (m2) => deps.log.erro(String(m2)),
      debug: () => undefined,
    };
    modulo = m;
    return m;
  }

  /**
   * Confere a assinatura Ed25519 do instalador baixado (ADR 0038). Falhou,
   * faltou `.sig`, ou não deu para ler o arquivo: LANÇA — a atualização não se
   * aplica, e `autoInstallOnAppQuit` fica desligado. Fail-closed: sem prova de
   * que o binário é o do dono, ele não roda.
   */
  async function conferirAssinatura(m: ModuloDoUpdater, caminho: string | undefined): Promise<void> {
    assinaturaVerificada = false;
    m.autoUpdater.autoInstallOnAppQuit = false;
    if (caminho === undefined || caminho === '' || feedAtual === null) {
      throw new Error('update sem caminho do instalador para verificar a assinatura');
    }
    const nome = caminho.split(/[/\\]/).pop() ?? '';
    const [instalador, assinatura] = await Promise.all([
      deps.lerArquivo(caminho),
      deps.baixarBinario(urlDaAssinatura(feedAtual + nome)),
    ]);
    if (instalador === null) throw new Error('não consegui ler o instalador baixado');
    if (assinatura === null) throw new Error('assinatura do update ausente no release (.sig)');
    if (!verificarAssinatura(instalador, assinatura)) {
      deps.log.erro('assinatura do update NÃO confere — instalação recusada (ADR 0038)');
      throw new Error('assinatura do update não confere');
    }
    assinaturaVerificada = true;
  }

  return {
    async verificar() {
      const release = releaseMaisNovaDoTexto(await deps.buscarLista());
      if (release === null || !ehMaisNova(release.versao, deps.versaoAtual)) return null;
      const pagina = urlDaPaginaDoRelease(release);
      // deb/rpm: avisar basta — o electron-updater nem é carregado.
      if (deps.modo !== 'automatica') return { versao: release.versao, pagina };

      const { autoUpdater } = await updater();
      // O provider `github` não acha tag com prefixo (ver `atualizacao-release.ts`):
      // aponta o `generic` para a pasta de downloads da release escolhida.
      feedAtual = urlDoFeed(release);
      assinaturaVerificada = false;
      autoUpdater.setFeedURL({ provider: 'generic', url: feedAtual });
      const resultado = await autoUpdater.checkForUpdates();
      // O updater tem a palavra final: compara a versão do `latest.yml` com a instalada.
      if (resultado === null || !resultado.isUpdateAvailable) return null;
      versaoAchada = resultado.updateInfo.version;
      return { versao: versaoAchada, pagina };
    },

    async baixar(aoProgresso) {
      const m = await updater();
      const atual = new m.CancellationToken();
      token = atual;
      const ouvinte = (info: { readonly percent: number }): void => aoProgresso(info.percent);
      m.autoUpdater.on('download-progress', ouvinte);
      try {
        // `downloadUpdate` resolve com os caminhos dos arquivos baixados.
        const arquivos = await m.autoUpdater.downloadUpdate(atual);
        const caminho = Array.isArray(arquivos) ? arquivos[0] : undefined;
        await conferirAssinatura(m, caminho);
        return versaoAchada;
      } catch (erro: unknown) {
        // Cancelar o token rejeita a promessa: não é falha, é a política mandando parar.
        if (atual.cancelled) return null;
        throw erro;
      } finally {
        m.autoUpdater.removeListener('download-progress', ouvinte);
        if (token === atual) token = null;
      }
    },

    cancelarDownload() {
      token?.cancel();
    },

    instalarAoSair(ligado) {
      // Só instala ao sair o que teve a assinatura conferida (ADR 0038).
      if (modulo !== null) modulo.autoUpdater.autoInstallOnAppQuit = ligado && assinaturaVerificada;
    },

    instalarAgora() {
      if (modulo === null) return;
      if (!assinaturaVerificada) {
        deps.log.erro('instalação recusada: assinatura do update não verificada (ADR 0038)');
        return;
      }
      deps.aoReiniciar();
      // Silencioso (o assistente do NSIS não aparece) e reabre o app.
      modulo.autoUpdater.quitAndInstall(true, true);
    },
  };
}
