import { useEffect, useRef } from 'react';

/**
 * Toca o bipe quando chega um pedido NOVO (ADR 0025).
 *
 * Só no novo: a lista muda também quando alguém é aceito ou desiste, e o
 * transmissor reconectando reapresenta pedidos que ele já ouviu — bipar de
 * novo por eles seria ruído no meio da partida.
 */
export function useBipeDePedido(ids: readonly string[], bipe: () => void): void {
  const ouvidos = useRef<ReadonlySet<string>>(new Set());
  const chave = ids.join('|');
  useEffect(() => {
    const atuais = chave === '' ? [] : chave.split('|');
    if (atuais.some((id) => !ouvidos.current.has(id))) bipe();
    ouvidos.current = new Set([...ouvidos.current, ...atuais]);
  }, [chave, bipe]);
}
