// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type FonteDeVisibilidade, useAbaVisivel } from './use-aba-visivel.js';

afterEach(cleanup);

function visibilidade(estado: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: estado });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useAbaVisivel', () => {
  it('escreve data-aba no <html> e acompanha a visibilidade', () => {
    visibilidade('visible');
    renderHook(() => useAbaVisivel());
    expect(document.documentElement.dataset['aba']).toBe('visivel');

    act(() => visibilidade('hidden'));
    expect(document.documentElement.dataset['aba']).toBe('oculta');

    act(() => visibilidade('visible'));
    expect(document.documentElement.dataset['aba']).toBe('visivel');
  });

  it('não deixa o atributo para trás ao desmontar', () => {
    visibilidade('hidden');
    const { unmount } = renderHook(() => useAbaVisivel());

    unmount();

    expect(document.documentElement.dataset['aba']).toBeUndefined();
  });

  it('aceita outra fonte: o app desktop é avisado pelo processo principal', () => {
    let visivel = true;
    const ouvintes = new Set<() => void>();
    const fonte: FonteDeVisibilidade = {
      visivel: () => visivel,
      assinar: (o) => {
        ouvintes.add(o);
        return () => ouvintes.delete(o);
      },
    };
    const { unmount } = renderHook(() => useAbaVisivel(fonte));
    expect(document.documentElement.dataset['aba']).toBe('visivel');

    act(() => {
      visivel = false;
      ouvintes.forEach((o) => o());
    });
    expect(document.documentElement.dataset['aba']).toBe('oculta');

    unmount();
    expect(ouvintes.size).toBe(0);
  });
});
