/**
 * Os sons do produto (§10 da coreografia, e ADR 0025).
 *
 * A abertura é MUDA — sem exceção, sem truque. Depois do primeiro gesto do
 * usuário, o som entra como recompensa da ação: a TV ligando ao apertar IR AO
 * AR, e silêncio quando a transmissão sobe, porque aí o produto assumiu.
 *
 * É uma porta e não uma chamada direta ao Web Audio porque o `core/` não
 * conhece navegador (R3) e porque o mudo global tem de valer para qualquer
 * implementação futura.
 */
export type AudioCue = {
  /**
   * A TV ligando: baque grave, um resto de chiado e um arpejo maior subindo,
   * ~0,6 s. Silencioso se estiver mudo.
   */
  readonly estouro: () => void;
  /**
   * Dois tons curtos: alguém pediu para assistir. Quem transmite está no jogo,
   * com a aba atrás — sem som, o pedido esperaria até ele olhar. Também
   * silencioso se estiver mudo.
   */
  readonly bipe: () => void;
  /**
   * A transmissão foi ocultada (`true`, dois tons descendo) ou voltou
   * (`false`, subindo). Quem aperta o atalho está no jogo em tela cheia e não
   * vê a janela do Tela: ouve. Silencioso se estiver mudo.
   */
  readonly privacidade: (oculto: boolean) => void;
  readonly estaMudo: () => boolean;
  readonly alternaMudo: () => void;
};
