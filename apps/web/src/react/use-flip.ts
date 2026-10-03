import { useCallback, useLayoutEffect, useRef } from 'react';

const DURACAO_MS = 220;

/**
 * A troca de lugar, animada sem custo de layout (FLIP): mede onde o
 * elemento estava, deixa o React pô-lo no lugar novo e anima só o
 * `transform` de lá para cá — composição na GPU, nenhum reflow por quadro.
 *
 * `chave` é o que define "o lugar": quando ela muda, anima. Sem
 * `prefers-reduced-motion`, e sem Web Animations, o salto é seco.
 *
 * Devolve `lembrarPosicao`: quem move o elemento por fora (o arrasto) a
 * chama antes de mudar a chave, para a animação partir de onde ele está.
 */
export function useFlip(el: HTMLElement | null, chave: string): () => void {
  const antes = useRef<DOMRect | null>(null);
  const chaveAnterior = useRef(chave);

  useLayoutEffect(() => {
    if (el === null) return;
    const agora = el.getBoundingClientRect();
    const de = antes.current;
    const mudou = chaveAnterior.current !== chave;
    antes.current = agora;
    chaveAnterior.current = chave;
    if (!mudou || de === null || agora.width === 0 || agora.height === 0) return;
    if (typeof el.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const dx = de.left - agora.left;
    const dy = de.top - agora.top;
    const sx = de.width / agora.width;
    const sy = de.height / agora.height;
    el.animate(
      [
        { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: 'top left', transform: 'none' },
      ],
      { duration: DURACAO_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
  }, [el, chave]);

  return useCallback(() => {
    if (el !== null) antes.current = el.getBoundingClientRect();
  }, [el]);
}
