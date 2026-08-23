import { useCallback, useEffect, useState } from 'react';

/**
 * Controles que somem sozinhos e voltam no movimento do mouse.
 *
 * No HUD do transmissor o vídeo é o jogo dele — qualquer pixel nosso em cima
 * é atrito. No player do espectador, idem. Voltam também no foco por teclado,
 * senão quem navega sem mouse nunca alcança os botões.
 */
export function useAutoHide(delayMs: number, enabled = true): {
  visible: boolean;
  show: () => void;
} {
  const [visible, setVisible] = useState(true);

  const show = useCallback(() => setVisible(true), []);

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

    window.addEventListener('mousemove', reveal);
    window.addEventListener('touchstart', reveal);
    window.addEventListener('focusin', reveal);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', reveal);
      window.removeEventListener('touchstart', reveal);
      window.removeEventListener('focusin', reveal);
    };
  }, [delayMs, enabled]);

  return { visible, show };
}
