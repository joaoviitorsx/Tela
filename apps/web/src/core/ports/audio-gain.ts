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
export type AudioGain = {
  /**
   * Envolve a trilha capturada e devolve a que deve ser transmitida.
   *
   * Se o navegador não tiver Web Audio utilizável, devolve a trilha original:
   * perder o controle de volume é ruim, perder o áudio é pior.
   */
  attach(track: MediaStreamTrack): MediaStreamTrack;

  /** 0 = mudo para quem assiste, 1 = o que a captura entregou. */
  set(value: number): void;

  /** `true` quando o ganho está mesmo no caminho — falso se caiu no fallback. */
  readonly ativo: boolean;

  close(): void;
};
