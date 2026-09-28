// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAbaVisivel } from './use-aba-visivel.js';

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
});
