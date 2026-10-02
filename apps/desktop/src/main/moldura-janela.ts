/**
 * A moldura da janela (PLANO-desktop §11), como funções puras: o que o
 * `BrowserWindow` recebe em cada sistema e o que cada pedido da barra própria
 * pode fazer. Nada de Electron aqui, para os testes rodarem sem binário.
 *
 * - Windows: `titleBarStyle: 'hidden'` + `titleBarOverlay`. Min/máx/fechar
 *   continuam do sistema (Snap Layouts, acessibilidade); a página desenha só
 *   o lado esquerdo da barra.
 * - Linux (X11 e Wayland): `frame: false`; a página desenha os três botões e
 *   pede ao main por IPC. O redimensionamento pelas bordas é do próprio
 *   Electron em janela sem moldura (D4, "Moldura" no PLANO §11).
 * - macOS: não é alvo; fica a moldura padrão.
 */

/** A altura da barra, igual à da ilustração do site (`h-8`). */
export const ALTURA_DA_BARRA = 32;
/** `--color-void` de `globals.css`: a faixa nativa tem de casar com a barra. */
export const COR_DA_BARRA = '#0b0c0e';
/** `--color-accent`: os símbolos do overlay nativo do Windows. */
export const COR_DOS_SIMBOLOS = '#f2a93b';

export type OpcoesDeMoldura = {
  readonly frame?: false;
  readonly titleBarStyle?: 'hidden';
  readonly titleBarOverlay?: { readonly color: string; readonly symbolColor: string; readonly height: number };
};

export function opcoesDeMoldura(plataforma: string): OpcoesDeMoldura {
  if (plataforma === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: COR_DA_BARRA, symbolColor: COR_DOS_SIMBOLOS, height: ALTURA_DA_BARRA },
    };
  }
  if (plataforma === 'linux') return { frame: false };
  return {};
}

export type AcaoDeJanela = 'minimizar' | 'alternar-maximizar' | 'fechar';

export type EntradaDeAcao = {
  readonly modoCompacto: boolean;
  readonly maximizada: boolean;
  readonly telaCheia: boolean;
};

export type DecisaoDeAcao = 'minimizar' | 'maximizar' | 'restaurar' | 'fechar' | 'ignorar';

/**
 * O que um pedido da barra faz. `fechar` NÃO decide nada aqui: vira
 * `win.close()` e o `close` da janela passa pela política de D4, a mesma do
 * fechar nativo. Maximizar não existe no compacto nem em tela cheia.
 */
export function decidirAcaoDeJanela(acao: AcaoDeJanela, e: EntradaDeAcao): DecisaoDeAcao {
  switch (acao) {
    case 'minimizar':
      return 'minimizar';
    case 'fechar':
      return 'fechar';
    case 'alternar-maximizar':
      if (e.modoCompacto || e.telaCheia) return 'ignorar';
      return e.maximizada ? 'restaurar' : 'maximizar';
  }
}

/** Os pedidos da barra não levam dado: qualquer argumento a mais é lixo e o pedido é descartado. */
export function pedidoSemCarga(args: readonly unknown[]): boolean {
  return args.length === 0;
}

export type EstadoDaJanela = {
  readonly focada: boolean;
  readonly maximizada: boolean;
  readonly telaCheia: boolean;
};

type JanelaConsultavel = {
  isFocused(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
};

export function estadoDaJanela(j: JanelaConsultavel): EstadoDaJanela {
  return { focada: j.isFocused(), maximizada: j.isMaximized(), telaCheia: j.isFullScreen() };
}
