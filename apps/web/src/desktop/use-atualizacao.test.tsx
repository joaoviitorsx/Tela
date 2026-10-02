// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EstadoDaAtualizacao } from './ponte.js';
import { useAtualizacao } from './use-atualizacao.js';

afterEach(cleanup);

const ESTADO: EstadoDaAtualizacao = {
  modo: 'automatica',
  fase: 'em-dia',
  versaoNova: null,
  progresso: null,
  ultimaVerificacaoMs: null,
  erro: null,
  adiada: false,
  podeVerificar: true,
  podeReiniciar: false,
  pagina: null,
};

function ponteFalsa(inicial: EstadoDaAtualizacao | null) {
  let ouvinte: ((e: EstadoDaAtualizacao) => void) | null = null;
  const cancelar = vi.fn();
  return {
    ponte: {
      atualizacao: vi.fn(async () => inicial),
      aoMudarAtualizacao: vi.fn((o: (e: EstadoDaAtualizacao) => void) => {
        ouvinte = o;
        return cancelar;
      }),
      verificarAtualizacao: vi.fn(),
      reiniciarEAtualizar: vi.fn(),
    },
    empurrar: (e: EstadoDaAtualizacao) => ouvinte?.(e),
    cancelar,
  };
}

describe('useAtualizacao', () => {
  it('sem ponte, não há estado e os pedidos não fazem nada', () => {
    const { result } = renderHook(() => useAtualizacao(undefined));
    expect(result.current.estado).toBeNull();
    act(() => result.current.verificar());
  });

  it('lê o estado inicial, acompanha as mudanças e repassa os pedidos ao main', async () => {
    const f = ponteFalsa(ESTADO);
    const { result } = renderHook(() => useAtualizacao(f.ponte));
    await waitFor(() => expect(result.current.estado).toEqual(ESTADO));
    act(() => f.empurrar({ ...ESTADO, fase: 'baixando', progresso: 10 }));
    expect(result.current.estado?.progresso).toBe(10);
    act(() => result.current.verificar());
    act(() => result.current.reiniciar());
    expect(f.ponte.verificarAtualizacao).toHaveBeenCalledTimes(1);
    expect(f.ponte.reiniciarEAtualizar).toHaveBeenCalledTimes(1);
  });

  it('a resposta inicial não atropela uma mudança que chegou antes dela', async () => {
    let resolver: (e: EstadoDaAtualizacao) => void = () => undefined;
    const f = ponteFalsa(null);
    f.ponte.atualizacao.mockImplementation(() => new Promise((r) => (resolver = r)));
    const { result } = renderHook(() => useAtualizacao(f.ponte));
    act(() => f.empurrar({ ...ESTADO, fase: 'pronta' }));
    await act(async () => resolver(ESTADO));
    expect(result.current.estado?.fase).toBe('pronta');
  });

  it('desmontar cancela a assinatura', () => {
    const f = ponteFalsa(ESTADO);
    const { unmount } = renderHook(() => useAtualizacao(f.ponte));
    unmount();
    expect(f.cancelar).toHaveBeenCalled();
  });
});
