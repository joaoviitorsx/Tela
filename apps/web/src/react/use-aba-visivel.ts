import { useEffect } from 'react';

/**
 * Espelha `document.visibilityState` num atributo do <html>.
 *
 * O CSS usa `:root[data-aba="oculta"]` para pausar as animações (ver
 * `globals.css`). Quem transmite deixa esta aba atrás do jogo durante horas, e
 * o navegador já não pinta uma aba oculta — mas o relógio das animações CSS
 * segue andando, e elas retomam no meio do ciclo ao voltar. Pausar de verdade
 * é o que garante custo zero enquanto ninguém olha.
 */
export function useAbaVisivel(): void {
  useEffect(() => {
    const raiz = document.documentElement;
    const sincronizar = () => {
      raiz.dataset['aba'] = document.visibilityState === 'hidden' ? 'oculta' : 'visivel';
    };
    sincronizar();
    document.addEventListener('visibilitychange', sincronizar);
    return () => {
      document.removeEventListener('visibilitychange', sincronizar);
      delete raiz.dataset['aba'];
    };
  }, []);
}
