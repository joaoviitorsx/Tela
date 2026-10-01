import { useEffect } from 'react';

/**
 * De onde vem "a aba está visível?".
 *
 * Na web é `document.visibilityState`. No app desktop a janela roda com
 * `backgroundThrottling: false` e o Chromium nunca marca a página como oculta —
 * então é o processo principal que avisa (PLANO-desktop §3.2), e a fonte é
 * outra. O hook não sabe qual: só assina.
 */
export type FonteDeVisibilidade = {
  readonly visivel: () => boolean;
  /** Avisa a cada mudança; devolve o cancelamento. */
  readonly assinar: (ouvinte: () => void) => () => void;
};

export const visibilidadeDoDocumento: FonteDeVisibilidade = {
  visivel: () => document.visibilityState !== 'hidden',
  assinar: (ouvinte) => {
    document.addEventListener('visibilitychange', ouvinte);
    return () => document.removeEventListener('visibilitychange', ouvinte);
  },
};

/**
 * Espelha a visibilidade num atributo do <html>.
 *
 * O CSS usa `:root[data-aba="oculta"]` para pausar as animações (ver
 * `globals.css`). Quem transmite deixa esta aba atrás do jogo durante horas, e
 * o navegador já não pinta uma aba oculta — mas o relógio das animações CSS
 * segue andando, e elas retomam no meio do ciclo ao voltar. Pausar de verdade
 * é o que garante custo zero enquanto ninguém olha.
 */
export function useAbaVisivel(fonte: FonteDeVisibilidade = visibilidadeDoDocumento): void {
  useEffect(() => {
    const raiz = document.documentElement;
    const sincronizar = () => {
      raiz.dataset['aba'] = fonte.visivel() ? 'visivel' : 'oculta';
    };
    sincronizar();
    const cancelar = fonte.assinar(sincronizar);
    return () => {
      cancelar();
      delete raiz.dataset['aba'];
    };
  }, [fonte]);
}
