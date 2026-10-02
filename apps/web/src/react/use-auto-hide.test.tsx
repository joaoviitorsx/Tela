// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoHide } from './use-auto-hide.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useAutoHide', () => {
  it('some depois do atraso e volta com o mouse', () => {
    const { result } = renderHook(() => useAutoHide(2_000));
    expect(result.current.visible).toBe(true);
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.visible).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('mousemove'));
    });
    expect(result.current.visible).toBe(true);
  });

  it('toque "alterna": mouse e toque não revelam, o gesto decide', () => {
    const { result } = renderHook(() => useAutoHide(2_000, true, 'alterna'));
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.visible).toBe(false);

    // O mousemove que o toque gera depois do gesto não pode mostrar de novo.
    act(() => {
      window.dispatchEvent(new Event('mousemove'));
      window.dispatchEvent(new Event('touchstart'));
    });
    expect(result.current.visible).toBe(false);

    act(() => result.current.alternar());
    expect(result.current.visible).toBe(true);
    // Mostrada por toque, some de novo depois do atraso.
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.visible).toBe(false);
  });

  it('o foco por teclado revela em qualquer modo', () => {
    const { result } = renderHook(() => useAutoHide(2_000, true, 'alterna'));
    act(() => vi.advanceTimersByTime(2_000));
    act(() => {
      window.dispatchEvent(new Event('focusin'));
    });
    expect(result.current.visible).toBe(true);
  });
});
