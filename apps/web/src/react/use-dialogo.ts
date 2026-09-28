import { useCallback, useEffect, useRef } from 'react';

export type Dialogo = {
  readonly ref: React.RefObject<HTMLDialogElement | null>;
  /** Clique no fundo (o próprio <dialog>, não o conteúdo) fecha. */
  readonly aoClicar: (evento: React.MouseEvent<HTMLDialogElement>) => void;
};

/**
 * Liga um `<dialog>` nativo ao estado `aberto`.
 *
 * `showModal()` entrega de graça o que um modal feito à mão erra: foco preso
 * dentro, `Esc` fechando, o resto da página inerte para leitor de tela e o
 * foco devolvido ao botão que abriu. Só falta sincronizar o estado quando o
 * NAVEGADOR fecha (Esc), senão a próxima abertura seria ignorada.
 */
export function useDialogo(aberto: boolean, aoFechar: () => void): Dialogo {
  const ref = useRef<HTMLDialogElement | null>(null);
  const fechar = useRef(aoFechar);
  fechar.current = aoFechar;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (aberto && !el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    } else if (!aberto && el.open) {
      if (typeof el.close === 'function') el.close();
      else el.removeAttribute('open');
    }
  }, [aberto]);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const aoFecharNativo = () => fechar.current();
    el.addEventListener('close', aoFecharNativo);
    return () => el.removeEventListener('close', aoFecharNativo);
  }, []);

  const aoClicar = useCallback((evento: React.MouseEvent<HTMLDialogElement>) => {
    if (evento.target === evento.currentTarget) fechar.current();
  }, []);

  return { ref, aoClicar };
}
