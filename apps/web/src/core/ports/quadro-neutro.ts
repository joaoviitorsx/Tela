/**
 * O quadro que vai no lugar da tela durante a pausa de privacidade (TELA-022).
 *
 * Existe para a pausa não CONGELAR o último conteúdo: o `track.enabled =
 * false` manda preto, e congelar a trilha deixaria na tela de quem assiste
 * justamente o que a pessoa quis esconder. Um quadro neutro com a intenção
 * escrita ("transmissão pausada") resolve as duas coisas, sem protocolo novo:
 * o espectador vê o motivo no próprio vídeo.
 *
 * Porta porque desenhar exige canvas, e `core/` não conhece DOM (R1/R3).
 */
export type QuadroNeutro = {
  /** Uma trilha de vídeo nova com o quadro neutro; `null` se não der. */
  abrir(): MediaStreamTrack | null;
  /** Para a trilha e o desenho. Sem custo nenhum fora da pausa. */
  fechar(): void;
};
