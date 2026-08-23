/**
 * Timers atrás de uma porta. Sem isso, testar o heartbeat exigiria esperar
 * 10 segundos de verdade — e a máquina de estados fica dependente do relógio
 * do ambiente, que é a definição de teste instável.
 */
export type Cancel = () => void;

export type Scheduler = {
  every(intervalMs: number, task: () => void): Cancel;
  after(delayMs: number, task: () => void): Cancel;
  now(): number;
  /**
   * `true` quando a página está visível.
   *
   * O espectador que deixa a aba aberta enquanto joga não precisa de nada da
   * rede: ele não está olhando. Deixar o polling rodando é gastar o link e a
   * atenção do sistema de quem está no meio de uma partida.
   */
  isVisible(): boolean;
  /** Avisa quando a visibilidade muda, para retomar o que estava pausado. */
  onVisibilityChange(handler: () => void): Cancel;
};
