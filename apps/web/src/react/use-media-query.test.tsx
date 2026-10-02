// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSULTA_BARRA_COMPACTA, useBarraCompacta, useMediaQuery } from './use-media-query.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function falsoMatchMedia(inicial: boolean) {
  let ouvinte: (() => void) | null = null;
  const lista = {
    matches: inicial,
    addEventListener: (_: string, fn: () => void) => {
      ouvinte = fn;
    },
    removeEventListener: () => {
      ouvinte = null;
    },
  };
  const matchMedia = vi.fn(() => lista);
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    mudar: (v: boolean) => {
      lista.matches = v;
      ouvinte?.();
    },
  };
}

describe('useMediaQuery', () => {
  it('lê e acompanha a consulta', () => {
    const m = falsoMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(max-height: 500px)'));
    expect(result.current).toBe(false);
    act(() => m.mudar(true));
    expect(result.current).toBe(true);
  });

  it('sem matchMedia o layout cheio é o padrão', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useMediaQuery('(max-height: 500px)'));
    expect(result.current).toBe(false);
  });
});

describe('useBarraCompacta', () => {
  it('cobre celular deitado e celular em pé', () => {
    const m = falsoMatchMedia(true);
    const { result } = renderHook(() => useBarraCompacta());
    expect(result.current).toBe(true);
    expect(m.matchMedia).toHaveBeenCalledWith(CONSULTA_BARRA_COMPACTA);
    expect(CONSULTA_BARRA_COMPACTA).toContain('max-height: 500px');
    expect(CONSULTA_BARRA_COMPACTA).toContain('pointer: coarse');
  });
});
