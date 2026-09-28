// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lerVolumeGuardado, useVolumeTransmissao } from './use-volume-transmissao.js';

afterEach(cleanup);

const pref = (inicial: string | null) => {
  const escritas: string[] = [];
  return { read: () => inicial, write: (v: string) => escritas.push(v), escritas };
};

describe('lerVolumeGuardado', () => {
  it('sem preferência, a primeira transmissão sai em 100% (e não em zero)', () => {
    expect(lerVolumeGuardado(null)).toBe(1);
  });

  it('lixo no storage volta ao padrão em vez de virar NaN ou silêncio', () => {
    expect(lerVolumeGuardado('abc')).toBe(1);
    expect(lerVolumeGuardado('7')).toBe(1);
    expect(lerVolumeGuardado('-0.2')).toBe(1);
  });

  it('respeita o zero escolhido de propósito', () => {
    expect(lerVolumeGuardado('0.00')).toBe(0);
    expect(lerVolumeGuardado('0.40')).toBe(0.4);
  });
});

describe('useVolumeTransmissao', () => {
  it('grava a preferência e empurra o valor para quem aplica', () => {
    const p = pref('0.50');
    const aplicar = vi.fn();
    const { result } = renderHook(() => useVolumeTransmissao(p, aplicar));
    expect(result.current.volume).toBe(0.5);

    act(() => result.current.definir(0.8));

    expect(result.current.volume).toBe(0.8);
    expect(p.escritas).toEqual(['0.80']);
    expect(aplicar).toHaveBeenCalledWith(0.8);
  });

  it('limita ao intervalo 0–1', () => {
    const { result } = renderHook(() => useVolumeTransmissao(pref(null)));

    act(() => result.current.definir(3));
    expect(result.current.volume).toBe(1);

    act(() => result.current.definir(-1));
    expect(result.current.volume).toBe(0);
  });
});
