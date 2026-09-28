/**
 * Volume DA TRANSMISSÃO, do lado de quem transmite.
 *
 * # O problema que isto resolve
 *
 * Quem transmite abaixa o volume no alto-falante e continua saindo alto para
 * quem assiste. Não é bug de código: a captura de som do sistema pega o
 * stream ANTES do volume de saída do aparelho. Você mexe no que você ouve,
 * não no que você manda. É o mesmo comportamento do OBS.
 *
 * A consequência é que, sem este port, o transmissor NÃO TEM controle nenhum
 * sobre o que os amigos ouvem — só o espectador tem, um a um, e quem está
 * jogando não consegue nem baixar a música do jogo para conversar.
 *
 * Fica atrás de uma port porque `AudioContext` é API de browser, e `core/`
 * não conhece browser (R1/R3).
 */
/**
 * O estado do grafo, como o `AudioContext` o reporta (TELA-009, §6.4).
 *
 * `suspenso` é o caso que importava e ninguém via: o contexto nasce ou cai em
 * `suspended` (política de autoplay, aba em segundo plano no Safari, troca de
 * dispositivo), o destino emite silêncio, e a trilha publicada continua
 * `live`. Para o WebRTC está tudo certo; para os amigos, o som sumiu.
 * `interrompido` é o `interrupted` do Safari. `indisponivel` = sem grafo.
 */
export type EstadoGrafo = 'indisponivel' | 'suspenso' | 'ativo' | 'interrompido' | 'fechado';

export type AudioGain = {
  /**
   * Envolve a trilha capturada e devolve a que deve ser transmitida.
   *
   * Um grafo por vez: chamar de novo fecha o anterior antes de montar o novo.
   * Se o navegador não tiver Web Audio utilizável, devolve a trilha original:
   * perder o controle de volume é ruim, perder o áudio é pior.
   */
  attach(track: MediaStreamTrack): MediaStreamTrack;

  /**
   * 0 = mudo para quem assiste, 1 = o que a captura entregou.
   *
   * No fallback sem grafo, o volume intermediário não existe — mas o MUDO
   * continua valendo, desligando a trilha crua. Mandar o som cheio a quem
   * escolheu silêncio seria a pior forma de falhar.
   */
  set(value: number): void;

  /** `true` quando o ganho está mesmo no caminho — falso se caiu no fallback. */
  readonly ativo: boolean;

  readonly estado: EstadoGrafo;

  /** Avisa a cada mudança de estado do grafo. */
  onEstado(listener: (estado: EstadoGrafo) => void): () => void;

  /**
   * Tenta reativar um grafo suspenso. Precisa vir de um GESTO do usuário: o
   * navegador recusa `resume()` fora dele. Devolve o estado resultante.
   */
  retomar(): Promise<EstadoGrafo>;

  close(): void;
};
