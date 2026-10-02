/**
 * O seletor próprio de fontes (PLANO-desktop §11): o que o main lista, o que
 * o renderer pode escolher e o que o `setDisplayMediaRequestHandler`
 * responde — tudo puro, sem Electron, para os testes de IPC rodarem sem
 * binário. `main.ts` só embrulha isto no `desktopCapturer`.
 *
 * As formas aqui são CÓPIA do contrato em `apps/web/src/desktop/ponte.ts`
 * (`FonteDeCaptura`, `TipoDeFonte`): outra compilação, mesmos nomes.
 */

export type TipoDeFonte = 'tela' | 'janela';

/** O que atravessa o IPC para o renderer desenhar a miniatura. */
export type FonteDeCaptura = {
  readonly id: string;
  readonly nome: string;
  readonly tipo: TipoDeFonte;
  /** `data:image/jpeg;base64,…`, ou `null` quando o sistema não entregou. */
  readonly miniatura: string | null;
  /** Ícone do aplicativo dono da janela (`data:image/png;base64,…`), se houver. */
  readonly icone: string | null;
};

/**
 * O mínimo de um `DesktopCapturerSource` que a listagem usa. As imagens já
 * chegam serializadas: quem chama decide o formato, e o teste não precisa de
 * `NativeImage`.
 */
export type FonteDoSistema = {
  readonly id: string;
  readonly name: string;
  readonly miniatura: string | null;
  readonly icone: string | null;
};

/**
 * Miniaturas de 320×180: dá para reconhecer o jogo e cabe em ~15 KB de JPEG.
 * Uma listagem com 30 janelas fica abaixo de meio megabyte atravessando o
 * IPC — e ela só é refeita enquanto o seletor está aberto.
 */
export const TAMANHO_DA_MINIATURA = { width: 320, height: 180 } as const;

/** Qualidade do JPEG das miniaturas: abaixo disto o texto das janelas vira sopa. */
export const QUALIDADE_DA_MINIATURA = 70;

/** Acima disto a listagem vira custo, não escolha: ninguém procura entre 80 janelas. */
export const MAXIMO_DE_FONTES = 60;

/**
 * `screen:0:0` é tela, `window:1234:0` é janela: o tipo está no prefixo do id
 * que o Electron gera (docs do `DesktopCapturerSource`).
 */
export function tipoDaFonte(id: string): TipoDeFonte | null {
  if (id.startsWith('screen:')) return 'tela';
  if (id.startsWith('window:')) return 'janela';
  return null;
}

/**
 * A listagem como o renderer a recebe. Telas primeiro, na ordem do sistema;
 * janelas depois. Fora: a própria janela do Tela (transmitir o Tela é um
 * espelho infinito), janelas sem título (fantasmas de toolkits) e tudo que
 * não é tela nem janela.
 */
export function mapearFontes(
  fontes: readonly FonteDoSistema[],
  excluirIds: ReadonlySet<string> = new Set(),
): readonly FonteDeCaptura[] {
  const telas: FonteDeCaptura[] = [];
  const janelas: FonteDeCaptura[] = [];
  for (const f of fontes) {
    const tipo = tipoDaFonte(f.id);
    if (tipo === null || excluirIds.has(f.id)) continue;
    const nome = f.name.trim();
    if (tipo === 'janela' && nome === '') continue;
    const fonte: FonteDeCaptura = {
      id: f.id,
      nome: tipo === 'tela' ? nomeDaTela(nome, telas.length) : nome,
      tipo,
      miniatura: f.miniatura,
      icone: tipo === 'janela' ? f.icone : null,
    };
    (tipo === 'tela' ? telas : janelas).push(fonte);
  }
  return [...telas, ...janelas].slice(0, MAXIMO_DE_FONTES);
}

/** `Entire Screen` / `Screen 2` vêm em inglês do Chromium; a interface é em português. */
function nomeDaTela(nome: string, indice: number): string {
  if (/^entire screen$/i.test(nome)) return 'TELA INTEIRA';
  const n = /^screen (\d+)$/i.exec(nome);
  if (n !== null) return `TELA ${n[1]}`;
  return nome === '' ? `TELA ${indice + 1}` : nome;
}

/**
 * `escolherFonte(id)` vindo do renderer: só um id da ÚLTIMA listagem vale.
 * O renderer é uma página web — um id inventado poderia apontar uma janela
 * que nunca foi oferecida. `null` é cancelar, e também é válido.
 */
export function escolhaValida(
  payload: unknown,
  ultimaListagem: ReadonlyMap<string, unknown>,
): { readonly id: string } | { readonly id: null } | null {
  if (payload === null) return { id: null };
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > 256) return null;
  return ultimaListagem.has(payload) ? { id: payload } : null;
}

export type EscolhaPendente<F> = {
  readonly fonte: F;
  readonly tipo: TipoDeFonte;
};

/**
 * O que o `setDisplayMediaRequestHandler` responde com o seletor próprio.
 *
 * `null` = responder vazio: o `getDisplayMedia` da página rejeita com
 * `NotAllowedError`, que o adapter traduz em `DENIED` — cancelar o seletor é
 * escolha da pessoa, não falha (R4). O áudio `loopback` (som do sistema) só
 * existe no Windows e só faz sentido com a TELA: capturar uma janela no
 * Windows é mudo, e o `surface` que a sessão recebe tem de dizer a verdade
 * para a interface avisar.
 */
export function respostaDeCaptura<F>(
  escolha: EscolhaPendente<F> | null,
  plataforma: NodeJS.Platform,
  audioPedido: boolean,
): { readonly video: F; readonly audio?: 'loopback' } | null {
  if (escolha === null) return null;
  if (plataforma === 'win32' && audioPedido && escolha.tipo === 'tela') {
    return { video: escolha.fonte, audio: 'loopback' };
  }
  return { video: escolha.fonte };
}

/**
 * Onde o seletor próprio faz sentido: Windows e Linux X11. No Wayland o
 * `desktopCapturer` já passa pelo portal xdg-desktop-portal, que mostra o
 * diálogo do sistema — um seletor por cima dele seria pedir duas vezes, e o
 * portal não entrega miniaturas nem deixa escolher por id.
 */
export function usaSeletorProprio(
  plataforma: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (plataforma === 'win32') return true;
  if (plataforma !== 'linux') return false;
  if (env['XDG_SESSION_TYPE'] === 'wayland') return false;
  if (env['WAYLAND_DISPLAY'] !== undefined && env['WAYLAND_DISPLAY'] !== '') return false;
  return true;
}
