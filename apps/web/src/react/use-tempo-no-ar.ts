import { useEffect, useRef, useState } from 'react';

const dois = (n: number): string => String(n).padStart(2, '0');

/** `3725` -> `01:02:05`. */
export function formatarTempo(segundos: number): string {
  const total = Math.max(0, Math.floor(segundos));
  return `${dois(Math.floor(total / 3600))}:${dois(Math.floor(total / 60) % 60)}:${dois(total % 60)}`;
}

/**
 * O "NO AR 00:12:34".
 *
 * O relógio de parede começa quando `ativo` liga e NUNCA para com o console
 * escondido — quem volta ao console depois de uma hora de jogo quer ver uma
 * hora, não o tempo que a página ficou olhando. Já o TIQUE só acontece com
 * `correndo`: com o console recolhido (a plaqueta) ninguém lê o número, e um
 * setState por segundo re-renderizaria a rota inteira ao lado do jogo à toa.
 */
export function useTempoNoAr(ativo: boolean, correndo: boolean, agora: () => number = Date.now): string {
  const inicio = useRef<number | null>(null);
  const [segundos, setSegundos] = useState(0);

  useEffect(() => {
    if (!ativo) {
      inicio.current = null;
      setSegundos(0);
      return;
    }
    inicio.current ??= agora();
    const desde = inicio.current;
    if (!correndo) return;

    const atualizar = () => setSegundos(Math.floor((agora() - desde) / 1000));
    atualizar();
    const id = window.setInterval(atualizar, 1000);
    return () => window.clearInterval(id);
  }, [ativo, correndo, agora]);

  return formatarTempo(segundos);
}
