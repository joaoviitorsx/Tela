// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { textoDeEncerrar, useEncerrar } from './use-encerrar.js';

describe('textoDeEncerrar', () => {
  it('concorda no singular e no plural', () => {
    expect(textoDeEncerrar(1)).toBe('1 amigo está assistindo agora e vai perder a imagem.');
    expect(textoDeEncerrar(2)).toBe('2 amigos estão assistindo agora e vão perder a imagem.');
  });
});

describe('useEncerrar', () => {
  it('sozinho, encerra direto, sem perguntar', () => {
    const encerrar = vi.fn();
    const { result } = renderHook(() => useEncerrar(0, encerrar));
    act(() => result.current.pedir());
    expect(encerrar).toHaveBeenCalledTimes(1);
    expect(result.current.confirmando).toBe(false);
  });

  it('com plateia, pede confirmação e só encerra ao confirmar', () => {
    const encerrar = vi.fn();
    const { result } = renderHook(() => useEncerrar(2, encerrar));
    act(() => result.current.pedir());
    expect(result.current.confirmando).toBe(true);
    expect(encerrar).not.toHaveBeenCalled();

    act(() => result.current.confirmar());
    expect(encerrar).toHaveBeenCalledTimes(1);
    expect(result.current.confirmando).toBe(false);
  });

  it('continuar no ar cancela sem encerrar', () => {
    const encerrar = vi.fn();
    const { result } = renderHook(() => useEncerrar(3, encerrar));
    act(() => result.current.pedir());
    act(() => result.current.cancelar());
    expect(result.current.confirmando).toBe(false);
    expect(encerrar).not.toHaveBeenCalled();
  });
});
