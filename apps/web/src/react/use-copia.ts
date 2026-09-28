import { useCallback, useEffect, useRef, useState } from 'react';

export type Copia = {
  /** `true` durante `ms` depois de uma cópia que o navegador confirmou. */
  readonly copiado: boolean;
  readonly copiar: (texto: string) => void;
};

const escreverNaAreaDeTransferencia = (texto: string): Promise<void> =>
  navigator.clipboard.writeText(texto);

/**
 * "Copiar", e o "COPIADO" que dura um instante.
 *
 * O feedback só liga quando o navegador CONFIRMOU a escrita: clipboard exige
 * contexto seguro e gesto, e um "copiado" que não copiou manda a pessoa colar o
 * nada no Discord. A falha é silenciosa de propósito — não há o que oferecer
 * no lugar, e o texto continua visível na tela para selecionar à mão.
 */
export function useCopia(
  ms = 1_500,
  escrever: (texto: string) => Promise<void> = escreverNaAreaDeTransferencia,
): Copia {
  const [copiado, setCopiado] = useState(false);
  const relogio = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (relogio.current !== null) window.clearTimeout(relogio.current);
    },
    [],
  );

  const copiar = useCallback(
    (texto: string) => {
      void (async () => {
        try {
          await escrever(texto);
        } catch {
          return;
        }
        setCopiado(true);
        if (relogio.current !== null) window.clearTimeout(relogio.current);
        relogio.current = window.setTimeout(() => setCopiado(false), ms);
      })();
    },
    [escrever, ms],
  );

  return { copiado, copiar };
}
