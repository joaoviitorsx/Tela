// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AVISO_AO_VIVO, useCanalPorLink } from './use-canal-por-link.js';

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function ponteFalsa() {
  let ouvinte: ((slug: string) => void) | null = null;
  const cancelar = vi.fn();
  return {
    ponte: {
      aoAbrirCanal: (o: (slug: string) => void) => {
        ouvinte = o;
        return cancelar;
      },
    },
    emitir: (slug: string) => ouvinte?.(slug),
    cancelar,
  };
}

describe('useCanalPorLink', () => {
  it('navega para /<canal> sem recarregar', () => {
    const f = ponteFalsa();
    const irPara = vi.fn();
    renderHook(() => useCanalPorLink(f.ponte, irPara));
    act(() => f.emitir('joao'));
    expect(irPara).toHaveBeenCalledWith('/joao');
  });

  it('multivisão: a+b vira /a+b; pedaço ruim recusa tudo (ADR 0032)', () => {
    const f = ponteFalsa();
    const irPara = vi.fn();
    renderHook(() => useCanalPorLink(f.ponte, irPara));
    act(() => f.emitir('ana+bia'));
    expect(irPara).toHaveBeenCalledWith('/ana+bia');
    for (const ruim of ['ana+', 'ana+jv', 'ana+bia+caio', 'ana+transmitir']) act(() => f.emitir(ruim));
    expect(irPara).toHaveBeenCalledTimes(1);
  });

  it('revalida: o que o main mandou não vira rota se não for canal', () => {
    const f = ponteFalsa();
    const irPara = vi.fn();
    renderHook(() => useCanalPorLink(f.ponte, irPara));
    for (const ruim of ['..', 'transmitir', 'recuperar', 'JOAO', 'jv', 'a/b', 'https://x.com/joao', '']) {
      act(() => f.emitir(ruim));
    }
    expect(irPara).not.toHaveBeenCalled();
  });

  it('ao vivo: NÃO navega; avisa, e o aviso some sozinho', () => {
    window.history.replaceState({}, '', '/transmitir');
    const f = ponteFalsa();
    const irPara = vi.fn();
    const { result } = renderHook(() => useCanalPorLink(f.ponte, irPara));
    act(() => f.emitir('joao'));
    expect(irPara).not.toHaveBeenCalled();
    expect(result.current.aviso).toBe(AVISO_AO_VIVO);
    act(() => vi.advanceTimersByTime(8_000));
    expect(result.current.aviso).toBeNull();
  });

  it('dispensar fecha o aviso na hora', () => {
    window.history.replaceState({}, '', '/transmitir');
    const f = ponteFalsa();
    const { result } = renderHook(() => useCanalPorLink(f.ponte, vi.fn()));
    act(() => f.emitir('joao'));
    act(() => result.current.dispensar());
    expect(result.current.aviso).toBeNull();
  });

  it('sem ponte (dev no navegador) não faz nada; ao desmontar cancela a assinatura', () => {
    expect(renderHook(() => useCanalPorLink(undefined, vi.fn())).result.current.aviso).toBeNull();
    const f = ponteFalsa();
    const { unmount } = renderHook(() => useCanalPorLink(f.ponte, vi.fn()));
    unmount();
    expect(f.cancelar).toHaveBeenCalledOnce();
  });
});
