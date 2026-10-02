import { useCallback, useEffect, useState } from 'react';

/**
 * Controles que somem sozinhos e voltam no movimento do mouse.
 *
 * No HUD do transmissor o vídeo é o jogo dele — qualquer pixel nosso em cima
 * é atrito. No player do espectador, idem. Voltam também no foco por teclado,
 * senão quem navega sem mouse nunca alcança os botões.
 */
export function useAutoHide(
  delayMs: number,
  enabled = true,
  /**
   * `alterna`: o toque NÃO só revela, quem decide é `alternar` (um toque no
   * vídeo esconde, outro mostra). Sem isso o toque que esconde primeiro
   * revelava (V-01).
   */
  toque: 'revela' | 'alterna' = 'revela',
): {
  visible: boolean;
  show: () => void;
  alternar: () => void;
} {
  const [visible, setVisible] = useState(true);

  const show = useCallback(() => setVisible(true), []);
  const alternar = useCallback(() => setVisible((v) => !v), []);

  useEffect(() => {
    if (!enabled) {
      setVisible(true);
      return;
    }

    let timer = window.setTimeout(() => setVisible(false), delayMs);

    const reveal = () => {
      setVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setVisible(false), delayMs);
    };

    // Em `alterna` o dedo manda: o `mousemove` que o toque gera depois do
    // gesto também revelaria, e o toque que esconde acabava mostrando.
    if (toque === 'revela') {
      window.addEventListener('mousemove', reveal);
      window.addEventListener('touchstart', reveal);
    }
    window.addEventListener('focusin', reveal);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', reveal);
      window.removeEventListener('touchstart', reveal);
      window.removeEventListener('focusin', reveal);
    };
  }, [delayMs, enabled, toque]);

  // Em `alterna` quem mostra é o toque, então o relógio recomeça a cada
  // aparição: um toque que revela some de novo sozinho depois do atraso.
  useEffect(() => {
    if (!enabled || toque !== 'alterna' || !visible) return;
    const timer = window.setTimeout(() => setVisible(false), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, enabled, toque, visible]);

  return { visible, show, alternar };
}
