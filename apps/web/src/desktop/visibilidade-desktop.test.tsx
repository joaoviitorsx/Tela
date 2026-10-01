// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAbaVisivel } from '../react/use-aba-visivel.js';
import { fonteDeVisibilidadeDesktop } from './visibilidade-desktop.js';

afterEach(cleanup);

function ponteFalsa() {
  let ouvinte: ((visivel: boolean) => void) | null = null;
  const cancelar = vi.fn(() => {
    ouvinte = null;
  });
  return {
    aoMudarVisibilidade: vi.fn((o: (visivel: boolean) => void) => {
      ouvinte = o;
      return cancelar;
    }),
    avisar: (visivel: boolean) => ouvinte?.(visivel),
    cancelar,
  };
}

function visibilidadeDoDocumento(estado: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: estado });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('fonteDeVisibilidadeDesktop', () => {
  it('o aviso do processo principal pausa e retoma a interface', () => {
    visibilidadeDoDocumento('visible');
    const ponte = ponteFalsa();
    const fonte = fonteDeVisibilidadeDesktop(ponte);
    renderHook(() => useAbaVisivel(fonte));
    expect(document.documentElement.dataset['aba']).toBe('visivel');

    act(() => ponte.avisar(false));
    expect(document.documentElement.dataset['aba']).toBe('oculta');

    act(() => ponte.avisar(true));
    expect(document.documentElement.dataset['aba']).toBe('visivel');
  });

  it('o documento oculto também conta, e a janela visível não o desfaz', () => {
    visibilidadeDoDocumento('visible');
    const ponte = ponteFalsa();
    renderHook(() => useAbaVisivel(fonteDeVisibilidadeDesktop(ponte)));

    act(() => visibilidadeDoDocumento('hidden'));
    expect(document.documentElement.dataset['aba']).toBe('oculta');

    act(() => ponte.avisar(true));
    expect(document.documentElement.dataset['aba']).toBe('oculta');

    act(() => visibilidadeDoDocumento('visible'));
    expect(document.documentElement.dataset['aba']).toBe('visivel');
  });

  it('cancela a assinatura na ponte ao desmontar', () => {
    visibilidadeDoDocumento('visible');
    const ponte = ponteFalsa();
    const { unmount } = renderHook(() => useAbaVisivel(fonteDeVisibilidadeDesktop(ponte)));
    expect(ponte.aoMudarVisibilidade).toHaveBeenCalledTimes(1);

    unmount();

    expect(ponte.cancelar).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset['aba']).toBeUndefined();
  });
});
