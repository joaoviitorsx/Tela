import type { ComponentType } from 'react';

/**
 * O que o passo ÁUDIO da home precisa do app desktop (D3) — só tipos.
 *
 * Na web a home desenha o `AudioSourcePicker` do navegador. No app o
 * container entrega isto no lugar: um seletor com as três opções (sistema, só
 * o jogo, sem som) e um resumo do que vai ao ar. A home não sabe o que há
 * atrás — só desenha o seletor e lê o resumo.
 */
export type ResumoDoSom = {
  /** Uma palavra para o medidor: `SISTEMA`, `SÓ O JOGO`, `SEM SOM`. */
  readonly curto: string;
  /** O modo REAL por extenso: `SÓ O JOGO · Minecraft`. */
  readonly real: string;
  /** Não há som nenhum para ajustar volume. */
  readonly mudo: boolean;
  /**
   * O que a home entrega à sessão como `audioDeviceId`. `null` = sem som.
   * Um id fixo é o aviso "há som a capturar": quem captura é o adapter do app,
   * que lê a escolha direto da loja.
   */
  readonly idDeAudio: string | null;
  /** Por que ainda não dá para ir ao ar (escolheu "só o jogo" sem escolher o jogo). `null` = pode. */
  readonly pendente: string | null;
};

export type SomDoApp = {
  readonly Seletor: ComponentType;
  readonly useResumo: () => ResumoDoSom;
};
