// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopia } from './use-copia.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCopia', () => {
  it('confirma só depois de o navegador escrever, e volta sozinho', async () => {
    const escrever = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useCopia(1_500, escrever));

    await act(async () => result.current.copiar('https://tela.gg/jv#k=abc'));
    expect(escrever).toHaveBeenCalledWith('https://tela.gg/jv#k=abc');
    expect(result.current.copiado).toBe(true);

    act(() => vi.advanceTimersByTime(1_500));
    expect(result.current.copiado).toBe(false);
  });

  it('não diz "copiado" quando o navegador recusou', async () => {
    const escrever = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const { result } = renderHook(() => useCopia(1_500, escrever));

    await act(async () => result.current.copiar('x'));

    expect(result.current.copiado).toBe(false);
  });

  it('copiar de novo antes de acabar reinicia o relógio', async () => {
    const escrever = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useCopia(1_000, escrever));

    await act(async () => result.current.copiar('a'));
    act(() => vi.advanceTimersByTime(800));
    await act(async () => result.current.copiar('b'));
    act(() => vi.advanceTimersByTime(800));

    expect(result.current.copiado).toBe(true);
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.copiado).toBe(false);
  });
});
