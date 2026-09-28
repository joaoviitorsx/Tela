// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatarTempo, useTempoNoAr } from './use-tempo-no-ar.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('formatarTempo', () => {
  it('formata HH:MM:SS', () => {
    expect(formatarTempo(0)).toBe('00:00:00');
    expect(formatarTempo(65)).toBe('00:01:05');
    expect(formatarTempo(3725)).toBe('01:02:05');
  });

  it('não formata tempo negativo', () => {
    expect(formatarTempo(-3)).toBe('00:00:00');
  });
});

describe('useTempoNoAr', () => {
  it('conta a partir de quando ficou ativo', () => {
    let t = 1_000_000;
    const agora = () => t;
    const { result } = renderHook(() => useTempoNoAr(true, true, agora));

    t += 5_000;
    act(() => vi.advanceTimersByTime(1_000));

    expect(result.current).toBe('00:00:05');
  });

  it('com o console recolhido não tiqueia, mas o relógio não perde o tempo', () => {
    let t = 1_000_000;
    const agora = () => t;
    const { result, rerender } = renderHook(({ correndo }) => useTempoNoAr(true, correndo, agora), {
      initialProps: { correndo: false },
    });

    t += 60_000;
    act(() => vi.advanceTimersByTime(60_000));
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current).toBe('00:00:00');

    rerender({ correndo: true });
    expect(result.current).toBe('00:01:00');
  });

  it('desativado, zera e não deixa relógio pendurado', () => {
    const { result, unmount } = renderHook(() => useTempoNoAr(false, true));
    expect(result.current).toBe('00:00:00');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
