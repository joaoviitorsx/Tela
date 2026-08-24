/**
 * O aparelho na vitrine, atrás de uma porta.
 *
 * A abertura é uma coreografia: recebe quadros, tem começo e fim, e some. Esta
 * cena é o contrário — fica de pé enquanto a tela inicial estiver aberta e
 * reage ao que a pessoa faz. Por isso são duas portas e não uma: o que a
 * vitrine recebe não é tempo, é ESTADO do canal.
 *
 * O que ela mostra na tela do tubo é o mesmo dado que o campo mostra, e isso é
 * de propósito: a TV não é enfeite, é o monitor do canal que está sendo criado.
 */

export type StatusCanal =
  /** Ninguém digitou nada ainda. Na tela: chiado e SEM SINAL. */
  | 'vazio'
  /** O nome está sendo conferido. */
  | 'verificando'
  /** O nome não serve — 3 a 25 caracteres, minúsculas, números e hífen. */
  | 'invalido'
  /** O nome serve. Pronto para ir ao ar. */
  | 'livre';

export type EstadoVitrine = {
  readonly slug: string;
  readonly status: StatusCanal;
};

export type Vitrine = {
  /** Repinta a tela do tubo e acende a lâmpada do estado. */
  readonly mostra: (estado: EstadoVitrine) => void;
  readonly redimensiona: (largura: number, altura: number, dpr: number) => void;
  /** Devolve a GPU. Obrigatório: esta cena vive enquanto a home viver. */
  readonly dispose: () => void;
};

export type VitrineOpcoes = {
  readonly canvas: HTMLCanvasElement;
  readonly modeloUrl: string;
  readonly largura: number;
  readonly altura: number;
  readonly dpr: number;
  readonly movimentoReduzido: boolean;
  readonly estadoInicial: EstadoVitrine;
  /**
   * Clicaram no aparelho.
   *
   * O tubo troca de canal por conta própria; isto é o que a PÁGINA faz em
   * resposta, e hoje é pôr o cursor no campo. Um objeto de 340px que responde
   * ao clique e não leva a lugar nenhum é enfeite caro.
   */
  readonly aoClicar: () => void;
  readonly sinal: AbortSignal;
};

export type AbreVitrine = (opcoes: VitrineOpcoes) => Promise<Vitrine>;
