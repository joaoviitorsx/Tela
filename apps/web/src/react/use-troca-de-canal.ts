import { useCallback, useEffect, useRef, useState } from 'react';

export type TrocaDeCanal<P extends number> = {
  readonly passo: P;
  /** O chiado entre um passo e outro está na tela. */
  readonly estatica: boolean;
  /** O número do canal recém-sintonizado, piscando no canto. */
  readonly flash: boolean;
  readonly irPara: (proximo: P) => void;
};

type Opcoes = {
  readonly estaticaMs?: number;
  readonly flashMs?: number;
  /** Injetável para teste; o padrão lê `prefers-reduced-motion`. */
  readonly movimentoReduzido?: () => boolean;
};

const lerMovimentoReduzido = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A troca de passo como troca de canal: chiado curto, depois o número.
 *
 * O conteúdo novo só entra DEPOIS do chiado — é o que faz o chiado parecer
 * transição e não um enfeite por cima. Sob `prefers-reduced-motion` o passo
 * troca na hora e nenhum dos dois efeitos existe: nenhuma informação vivia
 * neles.
 *
 * Os relógios são limpos ao desmontar e a cada troca; uma troca no meio da
 * outra vence, em vez de as duas se empilharem.
 */
export function useTrocaDeCanal<P extends number>(
  inicial: P,
  { estaticaMs = 260, flashMs = 1_600, movimentoReduzido = lerMovimentoReduzido }: Opcoes = {},
): TrocaDeCanal<P> {
  const [passo, setPasso] = useState<P>(inicial);
  const [estatica, setEstatica] = useState(false);
  const [flash, setFlash] = useState(false);
  const relogios = useRef<number[]>([]);
  const alvo = useRef<P>(inicial);

  const limpar = useCallback(() => {
    for (const id of relogios.current) window.clearTimeout(id);
    relogios.current = [];
  }, []);

  useEffect(() => limpar, [limpar]);

  const irPara = useCallback(
    (proximo: P) => {
      if (proximo === alvo.current) return;
      limpar();
      alvo.current = proximo;

      if (movimentoReduzido()) {
        setPasso(proximo);
        setEstatica(false);
        setFlash(false);
        return;
      }

      setEstatica(true);
      relogios.current.push(
        window.setTimeout(() => {
          setPasso(proximo);
          setEstatica(false);
          setFlash(true);
        }, estaticaMs),
        window.setTimeout(() => setFlash(false), estaticaMs + flashMs),
      );
    },
    [estaticaMs, flashMs, limpar, movimentoReduzido],
  );

  return { passo, estatica, flash, irPara };
}
