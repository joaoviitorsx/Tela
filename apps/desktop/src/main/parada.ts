/**
 * O portão da parada (D4): "para a sessão e avisa quando acabou, mas não
 * espere para sempre". Sair com a transmissão no ar manda o renderer chamar
 * `stop()` (libera trilhas e peers e avisa a sala) e espera a confirmação —
 * com prazo, porque um renderer travado não pode prender o app aberto.
 */
export type PortaoDeParada = {
  /** Resolve `true` se o renderer confirmou, `false` se o prazo estourou. */
  readonly aguardar: () => Promise<boolean>;
  /** O renderer confirmou (ou o estado já é "fora do ar"). */
  readonly confirmar: () => void;
};

export const PRAZO_DA_PARADA_MS = 4000;

export function criarPortaoDeParada(
  agendar: (fn: () => void, ms: number) => () => void,
  prazoMs: number = PRAZO_DA_PARADA_MS,
): PortaoDeParada {
  let resolver: ((confirmou: boolean) => void) | null = null;
  let cancelarPrazo: (() => void) | null = null;
  let confirmada = false;
  return {
    aguardar: () =>
      new Promise<boolean>((resolve) => {
        if (confirmada) {
          resolve(true);
          return;
        }
        resolver = resolve;
        cancelarPrazo = agendar(() => {
          resolver = null;
          resolve(false);
        }, prazoMs);
      }),
    confirmar: () => {
      confirmada = true;
      cancelarPrazo?.();
      cancelarPrazo = null;
      const r = resolver;
      resolver = null;
      r?.(true);
    },
  };
}
