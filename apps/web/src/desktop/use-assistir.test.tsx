// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAssistir } from './use-assistir.js';

afterEach(cleanup);

describe('useAssistir', () => {
  it('cola um link, vai para /<canal> e fecha', () => {
    const irPara = vi.fn();
    const { result } = renderHook(() => useAssistir(irPara));
    act(() => result.current.abrir());
    expect(result.current.aberto).toBe(true);
    act(() => result.current.mudar('https://tela.gg/joao'));
    act(() => result.current.enviar());
    expect(irPara).toHaveBeenCalledWith('/joao');
    expect(result.current.aberto).toBe(false);
  });
  it('aceita só o nome e o link do app', () => {
    const irPara = vi.fn();
    const { result } = renderHook(() => useAssistir(irPara));
    act(() => result.current.mudar('Maria'));
    act(() => result.current.enviar());
    act(() => result.current.mudar('tela://assistir/pedro'));
    act(() => result.current.enviar());
    expect(irPara.mock.calls).toEqual([['/maria'], ['/pedro']]);
  });
  it('entrada que não é canal fica aberta, marcada inválida, e some ao digitar', () => {
    const irPara = vi.fn();
    const { result } = renderHook(() => useAssistir(irPara));
    act(() => result.current.abrir());
    act(() => result.current.mudar('???'));
    act(() => result.current.enviar());
    expect(irPara).not.toHaveBeenCalled();
    expect(result.current.invalido).toBe(true);
    expect(result.current.aberto).toBe(true);
    act(() => result.current.mudar('joao'));
    expect(result.current.invalido).toBe(false);
  });
  it('reabrir limpa o que sobrou', () => {
    const { result } = renderHook(() => useAssistir(vi.fn()));
    act(() => result.current.mudar('???'));
    act(() => result.current.enviar());
    act(() => result.current.abrir());
    expect(result.current.valor).toBe('');
    expect(result.current.invalido).toBe(false);
  });

  it('RECENTES: lidos ao abrir; um toque entra no canal e fecha', () => {
    const irPara = vi.fn();
    const listar = vi.fn(() => ['amigo', 'outra-pessoa']);
    const { result } = renderHook(() => useAssistir(irPara, listar));
    expect(result.current.recentes).toEqual([]);
    act(() => result.current.abrir());
    expect(listar).toHaveBeenCalledOnce();
    expect(result.current.recentes).toEqual(['amigo', 'outra-pessoa']);
    act(() => result.current.escolher('amigo'));
    expect(irPara).toHaveBeenCalledWith('/amigo');
    expect(result.current.aberto).toBe(false);
  });

  it('RECENTES: um nome adulterado no armazenamento não navega', () => {
    const irPara = vi.fn();
    const { result } = renderHook(() => useAssistir(irPara, () => ['../../x']));
    act(() => result.current.abrir());
    act(() => result.current.escolher('../../x'));
    expect(irPara).not.toHaveBeenCalled();
    expect(result.current.aberto).toBe(true);
  });

  it('RECENTES: só os que a tecla abre, sem repetir', () => {
    const { result } = renderHook(() => useAssistir(vi.fn(), () => ['amigo', 'transmitir', 'amigo', 'x']));
    act(() => result.current.abrir());
    expect(result.current.recentes).toEqual(['amigo']);
  });
});
