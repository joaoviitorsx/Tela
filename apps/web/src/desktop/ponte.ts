/**
 * A ponte entre o renderer e o processo principal do Tela Desktop.
 *
 * O preload (`apps/desktop/src/preload/preload.cts`) expõe exatamente isto em
 * `window.telaDesktop`, por `contextBridge`. Operações nomeadas, nada de acesso
 * genérico a Node nem a `ipcRenderer` (PLANO-desktop §3.3–3.4). Este arquivo é
 * o CONTRATO: os dois lados seguem os nomes daqui.
 *
 * Na web `window.telaDesktop` não existe — quem precisa dela está em
 * `src/desktop/`, que só entra no build do app.
 */
export type PlataformaDesktop = 'win32' | 'linux' | 'darwin';

export interface PonteDesktop {
  readonly plataforma: PlataformaDesktop;
  /** Versão do app (`app.getVersion()`), para o diagnóstico. */
  readonly versao: string;
  /**
   * A janela apareceu ou sumiu (minimizada, escondida, restaurada). Com
   * `backgroundThrottling: false` a página não fica sabendo sozinha, então o
   * main avisa (§3.2). Devolve a função que cancela a assinatura.
   */
  aoMudarVisibilidade(ouvinte: (visivel: boolean) => void): () => void;
  /** Abre um link `https:` no navegador do sistema. O main valida e recusa o resto. */
  abrirNoNavegador(url: string): void;
}

/** Nomes dos canais IPC. Os dois lados importam daqui ou copiam igual. */
export const CANAIS = {
  /** main → renderer, `boolean` */
  visibilidade: 'tela:visibilidade',
  /** renderer → main, `string` (URL) */
  abrirNoNavegador: 'tela:abrir-no-navegador',
} as const;

declare global {
  interface Window {
    readonly telaDesktop?: PonteDesktop;
  }
}
