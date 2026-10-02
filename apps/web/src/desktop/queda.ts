/**
 * "A TRANSMISSÃO CAIU" (D4, PLANO §3.1). Quando o processo da interface morre,
 * o main recarrega a janela em `?queda=<motivo>`; aqui o motivo vira texto.
 * Nada é restaurado: a sessão morreu junto com o renderer, e fingir
 * continuidade seria mentir a quem transmitia.
 *
 * Os motivos são os do `render-process-gone` do Electron — a lista é a mesma
 * de `apps/desktop/src/main/politica-de-fechar.ts` (outra compilação, cópia).
 */
export const MOTIVOS_DE_QUEDA = [
  'crashed',
  'oom',
  'killed',
  'abnormal-exit',
  'launch-failed',
  'integrity-failure',
  'memory-eval',
] as const;
export type MotivoDeQueda = (typeof MOTIVOS_DE_QUEDA)[number];

export const TEXTO_DA_QUEDA: Record<MotivoDeQueda, string> = {
  crashed: 'A interface do Tela travou de repente.',
  oom: 'O Tela ficou sem memória e a interface foi encerrada pelo sistema.',
  killed: 'A interface do Tela foi encerrada por outro programa ou pelo sistema.',
  'abnormal-exit': 'A interface do Tela terminou de forma inesperada.',
  'launch-failed': 'A interface do Tela não conseguiu iniciar.',
  'integrity-failure': 'A interface do Tela foi bloqueada por uma falha de integridade.',
  'memory-eval': 'A interface do Tela foi bloqueada por uma falha de memória.',
};

/** O motivo da queda em `?queda=`, ou `null` se a página não é uma recuperação. */
export function motivoDaQueda(search: string): MotivoDeQueda | null {
  const bruto = new URLSearchParams(search).get('queda');
  if (bruto === null) return null;
  return (MOTIVOS_DE_QUEDA as readonly string[]).includes(bruto) ? (bruto as MotivoDeQueda) : 'crashed';
}
