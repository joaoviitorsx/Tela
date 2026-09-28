/**
 * Os sons do produto (§10 da coreografia, e ADR 0025).
 *
 * A abertura é MUDA — sem exceção, sem truque. Depois do primeiro gesto do
 * usuário, o chiado entra como recompensa da ação: um estouro curto ao apertar
 * TRANSMITIR, e silêncio quando a transmissão sobe, porque aí o produto
 * assumiu.
 *
 * É uma porta e não uma chamada direta ao Web Audio porque o `core/` não
 * conhece navegador (R3) e porque o mudo global tem de valer para qualquer
 * implementação futura.
 */
export type AudioCue = {
  /** Estouro de ruído, 180 ms, envelope decaindo. Silencioso se estiver mudo. */
  readonly estouro: () => void;
  /**
   * Dois tons curtos: alguém pediu para assistir. Quem transmite está no jogo,
   * com a aba atrás — sem som, o pedido esperaria até ele olhar. Também
   * silencioso se estiver mudo.
   */
  readonly bipe: () => void;
  readonly estaMudo: () => boolean;
  readonly alternaMudo: () => void;
};
