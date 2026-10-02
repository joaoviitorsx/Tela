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

  async function updater(): Promise<ModuloDoUpdater> {
    if (modulo !== null) return modulo;
    const m = await deps.carregarUpdater();
    const u = m.autoUpdater;
    // Quem decide quando baixar é a política (nunca ao vivo).
    u.autoDownload = false;
    // Ligado desde já: o updater só registra o gancho de "instalar ao sair" ao
    // terminar um download E se a flag estiver ligada naquele instante. O gancho
    // reconsulta a flag ao sair — é por ela (`instalarAoSair`) que a política
    // liga e desliga. Sem download concluído, não há gancho nem o que instalar.
    u.autoInstallOnAppQuit = true;
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
      autoUpdater.setFeedURL({ provider: 'generic', url: urlDoFeed(release) });
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
        await m.autoUpdater.downloadUpdate(atual);
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
      if (modulo !== null) modulo.autoUpdater.autoInstallOnAppQuit = ligado;
    },

    instalarAgora() {
      if (modulo === null) return;
      deps.aoReiniciar();
      // Silencioso (o assistente do NSIS não aparece) e reabre o app.
      modulo.autoUpdater.quitAndInstall(true, true);
    },
  };
}
