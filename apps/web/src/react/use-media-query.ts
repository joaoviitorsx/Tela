import { useCallback, useSyncExternalStore } from 'react';

/**
 * `matchMedia` como estado. Sem `matchMedia` (ambiente de teste, navegador
 * antigo) o resultado é `false`: o layout cheio é o padrão seguro.
 */
export function useMediaQuery(consulta: string): boolean {
  const assinar = useCallback(
    (aviso: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const lista = window.matchMedia(consulta);
      lista.addEventListener('change', aviso);
      return () => lista.removeEventListener('change', aviso);
    },
    [consulta],
  );
  const ler = useCallback(
    () => typeof window.matchMedia === 'function' && window.matchMedia(consulta).matches,
    [consulta],
  );
  return useSyncExternalStore(assinar, ler, () => false);
}

/**
 * A barra do espectador compacta (V-01, V-02): celular deitado (menos de 500px
 * de altura, onde a barra de duas linhas comia 31% da tela) ou celular em pé
 * (largura de telefone com ponteiro de dedo).
 */
export const CONSULTA_BARRA_COMPACTA = '(max-height: 500px), ((max-width: 600px) and (pointer: coarse))';

export function useBarraCompacta(): boolean {
  return useMediaQuery(CONSULTA_BARRA_COMPACTA);
}
