// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTrocaDeCanal } from './use-troca-de-canal.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useTrocaDeCanal', () => {
  it('o conteúdo novo só entra depois do chiado, e o número pisca por um tempo', () => {
    const { result } = renderHook(() => useTrocaDeCanal<1 | 2 | 3>(1, { movimentoReduzido: () => false }));

    act(() => result.current.irPara(2));
    expect(result.current).toMatchObject({ passo: 1, estatica: true, flash: false });

    act(() => vi.advanceTimersByTime(259));
    expect(result.current.passo).toBe(1);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toMatchObject({ passo: 2, estatica: false, flash: true });

    act(() => vi.advanceTimersByTime(1_600));
    expect(result.current.flash).toBe(false);
  });

  it('com movimento reduzido troca na hora, sem chiado nem número', () => {
    const { result } = renderHook(() => useTrocaDeCanal<1 | 2 | 3>(1, { movimentoReduzido: () => true }));

    act(() => result.current.irPara(3));

    expect(result.current).toMatchObject({ passo: 3, estatica: false, flash: false });
  });

  it('ir para o passo em que já está não faz nada', () => {
    const { result } = renderHook(() => useTrocaDeCanal<1 | 2 | 3>(2, { movimentoReduzido: () => false }));

    act(() => result.current.irPara(2));

    expect(result.current.estatica).toBe(false);
  });

  it('uma troca no meio da outra vence, sem empilhar relógios', () => {
    const { result } = renderHook(() => useTrocaDeCanal<1 | 2 | 3>(1, { movimentoReduzido: () => false }));

    act(() => result.current.irPara(2));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.irPara(3));
    act(() => vi.advanceTimersByTime(260));

    expect(result.current.passo).toBe(3);
  });

  it('desmontar cancela os relógios pendentes', () => {
    const { result, unmount } = renderHook(() =>
      useTrocaDeCanal<1 | 2 | 3>(1, { movimentoReduzido: () => false }),
    );
    act(() => result.current.irPara(2));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
