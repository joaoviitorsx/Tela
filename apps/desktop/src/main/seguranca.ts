import { ORIGEM_APP } from './protocolo-app.js';

/**
 * As decisões de segurança do processo principal (PLANO-desktop §3.4), puras.
 *
 * O renderer é uma página web com sandbox; o que ele pede ao main passa por
 * aqui ANTES de tocar o sistema. Tudo recebe `unknown` ou string e devolve
 * decisão — nada de Electron, para que os testes de IPC rodem sem binário.
 */

/**
 * `new URL('app://tela/x').origin` é `'null'`: esquema fora da lista do WHATWG
 * não tem origem para a plataforma. Como o Chromium trata `app://tela` como
 * origem de verdade (registrado `standard`), a origem é montada à mão.
 */
export function origemDe(url: string): string | null {
  let analisada: URL;
  try {
    analisada = new URL(url);
  } catch {
    return null;
  }
  if (analisada.host === '') return null;
  return `${analisada.protocol}//${analisada.host}`;
}

/**
 * De onde a interface pode vir: o `app://` e, em desenvolvimento, o Vite
 * (`TELA_DESKTOP_URL`). Uma URL de dev que não se parse é ignorada — melhor um
 * app que só abre `app://` do que uma lista de origens com lixo dentro.
 */
export function origensPermitidas(urlDeDesenvolvimento: string | undefined): ReadonlySet<string> {
  const origens = new Set([ORIGEM_APP]);
  if (urlDeDesenvolvimento !== undefined) {
    const origem = origemDe(urlDeDesenvolvimento);
    if (origem !== null) origens.add(origem);
  }
  return origens;
}

export function origemPermitida(url: string | undefined, permitidas: ReadonlySet<string>): boolean {
  if (url === undefined) return false;
  const origem = origemDe(url);
  return origem !== null && permitidas.has(origem);
}

/** Navegação de primeiro nível: só dentro das origens da interface. */
export function podeNavegar(url: string, permitidas: ReadonlySet<string>): boolean {
  return origemPermitida(url, permitidas);
}

/**
 * Tamanho acima do qual uma "URL" deixa de ser um link e vira carga. O limite
 * dos navegadores fica perto disto, e nada que o Tela abre chega lá.
 */
const TAMANHO_MAXIMO_DE_URL = 2048;

/**
 * O único link que o app abre fora de si: `https:`, bem formado, de tamanho
 * razoável. Devolve a URL normalizada ou `null`. Qualquer outro esquema
 * (`file:`, `javascript:`, `tela:`…) é recusado em silêncio: `shell.openExternal`
 * entrega a string ao sistema, e o sistema faz o que o esquema mandar.
 */
export function urlExternaPermitida(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > TAMANHO_MAXIMO_DE_URL) return null;
  let analisada: URL;
  try {
    analisada = new URL(url);
  } catch {
    return null;
  }
  if (analisada.protocol !== 'https:' || analisada.host === '') return null;
  return analisada.href;
}

/**
 * `abrirNoNavegador` vindo do renderer: só de um frame da interface, só
 * `https:`. O frame é quem o Electron diz que mandou — o payload não prova nada.
 */
export function urlParaAbrirNoNavegador(
  urlDoFrame: string | undefined,
  url: unknown,
  permitidas: ReadonlySet<string>,
): string | null {
  if (!origemPermitida(urlDoFrame, permitidas)) return null;
  return urlExternaPermitida(url);
}

export type DecisaoDeJanelaNova = 'abrir-no-navegador' | 'negar';

/** Janela nova nunca abre no app. Um link `https:` vai para o navegador do sistema. */
export function decidirJanelaNova(url: string): DecisaoDeJanelaNova {
  return urlExternaPermitida(url) === null ? 'negar' : 'abrir-no-navegador';
}

/**
 * As permissões do Chromium que a interface precisa — e nenhuma outra:
 * captura e microfone (`media`), tela (`display-capture`), copiar o link
 * (`clipboard-sanitized-write`) e a prévia em tela cheia.
 */
const PERMISSOES_DA_INTERFACE: ReadonlySet<string> = new Set([
  'media',
  'display-capture',
  'clipboard-sanitized-write',
  'fullscreen',
]);

export function permissaoConcedida(
  permissao: string,
  urlDoPedido: string | undefined,
  permitidas: ReadonlySet<string>,
): boolean {
  return PERMISSOES_DA_INTERFACE.has(permissao) && origemPermitida(urlDoPedido, permitidas);
}
