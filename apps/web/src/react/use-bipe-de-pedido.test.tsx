// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBipeDePedido } from './use-bipe-de-pedido.js';

describe('useBipeDePedido', () => {
  it('bipa só quando chega um pedido que ainda não tocou', () => {
    const bipe = vi.fn();
    const { rerender } = renderHook(({ ids }) => useBipeDePedido(ids, bipe), {
      initialProps: { ids: [] as string[] },
    });
    expect(bipe).not.toHaveBeenCalled();
    rerender({ ids: ['v_1'] });
    expect(bipe).toHaveBeenCalledTimes(1);
    rerender({ ids: ['v_1', 'v_2'] });
    expect(bipe).toHaveBeenCalledTimes(2);
    // Aceitou um: a lista encolheu, nada toca.
    rerender({ ids: ['v_2'] });
    // Reapresentado depois de reconectar: já ouvido, nada toca.
    rerender({ ids: ['v_2', 'v_1'] });
    expect(bipe).toHaveBeenCalledTimes(2);
  });
});
