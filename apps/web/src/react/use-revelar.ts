import { useCallback, useEffect, useState } from 'react';

/**
 * Um segredo que se mostra por pouco tempo (R-01). Esta página costuma ser
 * aberta na hora de transmitir a tela inteira: revelar tem de se desfazer
 * sozinho, para o código não ficar no quadro que vai aos amigos.
 */
export function useRevelar(ms: number): {
  readonly revelado: boolean;
  readonly alternar: () => void;
  readonly esconder: () => void;
} {
  const [revelado, setRevelado] = useState(false);

  useEffect(() => {
    if (!revelado) return;
    const timer = window.setTimeout(() => setRevelado(false), ms);
    return () => window.clearTimeout(timer);
  }, [revelado, ms]);

  const alternar = useCallback(() => setRevelado((v) => !v), []);
  const esconder = useCallback(() => setRevelado(false), []);
  return { revelado, alternar, esconder };
}
