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
};
