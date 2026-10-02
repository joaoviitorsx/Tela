/**
 * "Abrir no app" na página do espectador (PLANO-desktop §14).
 *
 * Quem tem o Tela Desktop instalado e abre `tela.gg/<canal>` num navegador deve
 * cair no app — mas só quem de fato o tem, e só uma vez por aparelho. Tudo que
 * decide ISSO é função pura daqui; quem lança o `tela://` e observa o foco é o
 * adapter (`adapters/abrir-no-app.ts`).
 */

/** A janela de observação do foco. Também é o MÁXIMO que o viewer espera ao tentar. */
export const PRAZO_DA_TENTATIVA_MS = 1_500;

/** Chave de `localStorage`: "este aparelho já tentou e não há app". */
export const CHAVE_SEM_APP = 'tela.semApp';

export type ResultadoDaTentativa = 'abriu' | 'nao-abriu';

export type AmbienteDoNavegador = {
  readonly userAgent: string;
  /** `navigator.userAgentData.platform`, quando existe (Chromium). */
  readonly plataforma: string | null;
  /** `window.telaDesktop` existe: esta página JÁ é o app. */
  readonly dentroDoApp: boolean;
  /** `document.hasFocus()` — sem foco não há como notar que ele foi embora. */
  readonly paginaEmFoco: boolean;
  /**
   * `navigator.webdriver`: Playwright, Puppeteer. Navegador dirigido por teste
   * nunca tem o app, e 1,5 s a mais em cada abertura de canal estragaria as
   * medições de tempo até o primeiro quadro (`e2e/`).
   */
  readonly automatizado: boolean;
};

const MOVEL = /Mobi|Android|iPhone|iPad|iPod/i;
const OUTRO_MOTOR = /Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Firefox/i;

/**
 * Existe app para este navegador? Windows e Linux de mesa: sim. Celular, Mac,
 * ChromeOS e Safari: não (não há instalador, e o Safari trata esquema
 * desconhecido com um alerta que prende a página).
 */
export function haAppParaEsteNavegador(e: Pick<AmbienteDoNavegador, 'userAgent' | 'plataforma'>): boolean {
  const ua = e.userAgent;
  if (MOVEL.test(ua) || /CrOS/.test(ua)) return false;
  if (/Safari/.test(ua) && !OUTRO_MOTOR.test(ua)) return false;
  const so = (e.plataforma ?? '').toLowerCase();
  if (so !== '') return so.includes('windows') || so === 'linux';
  return /Windows NT/.test(ua) || /Linux|X11/.test(ua);
}

/** Mostrar o botão ABRIR NO APP: dá para abrir, e esta página não é o app. */
export function ofereceAbrirNoApp(e: AmbienteDoNavegador): boolean {
  return !e.dentroDoApp && haAppParaEsteNavegador(e);
}

export type Decisao =
  | { readonly tentar: true }
  | { readonly tentar: false; readonly motivo: 'sem-app' | 'ja-sem-app' | 'sem-foco' | 'automatizado' };

/**
 * Tentar abrir o app AUTOMATICAMENTE nesta visita?
 *
 * `sem-foco` não grava nada: a aba aberta em segundo plano (o link veio do
 * Discord com a janela atrás) não prova que não há app, só que não dá para
 * observar — e o navegador também recusa lançar esquema de página sem foco.
 */
export function decidirTentativa(e: AmbienteDoNavegador, semApp: boolean): Decisao {
  if (!ofereceAbrirNoApp(e)) return { tentar: false, motivo: 'sem-app' };
  if (e.automatizado) return { tentar: false, motivo: 'automatizado' };
  if (semApp) return { tentar: false, motivo: 'ja-sem-app' };
  if (!e.paginaEmFoco) return { tentar: false, motivo: 'sem-foco' };
  return { tentar: true };
}

/** O link que o app registrou no sistema. */
export function linkDoApp(slug: string): string {
  return `tela://assistir/${slug}`;
}
