// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRevelar } from './use-revelar.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useRevelar', () => {
  it('nasce escondido', () => {
    const { result } = renderHook(() => useRevelar(10_000));
    expect(result.current.revelado).toBe(false);
  });

  it('revela e volta a esconder sozinho depois do prazo', () => {
    const { result } = renderHook(() => useRevelar(10_000));
    act(() => result.current.alternar());
    expect(result.current.revelado).toBe(true);
    act(() => vi.advanceTimersByTime(9_999));
    expect(result.current.revelado).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.revelado).toBe(false);
  });

  it('esconder à mão cancela o prazo', () => {
    const { result } = renderHook(() => useRevelar(10_000));
    act(() => result.current.alternar());
    act(() => result.current.esconder());
    expect(result.current.revelado).toBe(false);
  });
});
