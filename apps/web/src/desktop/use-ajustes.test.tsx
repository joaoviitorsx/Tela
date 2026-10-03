// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AjustesDesktop, RespostaDeAjustes } from './ponte.js';
import { useAjustes } from './use-ajustes.js';

afterEach(cleanup);

const AJUSTES: AjustesDesktop = {
  iniciarComSistema: false,
  fecharEmSegundoPlano: false,
  sempreNoTopoNoCompacto: false,
  aoFecharAoVivo: 'perguntar',
  atualizarAutomaticamente: true,
  painelSobreOJogo: false,
  cantoDoPainel: 'sup-dir',
  taxaConstante: false,
};
const resposta = (sobre: Partial<RespostaDeAjustes> = {}): RespostaDeAjustes => ({
  ajustes: AJUSTES,
  bandeja: true,
  autostartFalhou: false,
  ...sobre,
});

describe('useAjustes', () => {
  it('sem ponte, não há ajustes', () => {
    const { result } = renderHook(() => useAjustes(undefined));
    expect(result.current.ajustes).toBeNull();
    act(() => result.current.mudar({ iniciarComSistema: true }));
    expect(result.current.ajustes).toBeNull();
  });

  it('lê do main ao montar', async () => {
    const ponte = { ajustes: vi.fn(async () => resposta({ bandeja: false })), salvarAjustes: vi.fn() };
    const { result } = renderHook(() => useAjustes(ponte));
    await waitFor(() => expect(result.current.ajustes).toEqual(AJUSTES));
    expect(result.current.bandeja).toBe(false);
  });

  it('mostra o que o main DEVOLVEU, não o que a pessoa pediu', async () => {
    const ponte = {
      ajustes: vi.fn(async () => resposta()),
      salvarAjustes: vi.fn(async () => resposta({ autostartFalhou: true })),
    };
    const { result } = renderHook(() => useAjustes(ponte));
    await waitFor(() => expect(result.current.ajustes).not.toBeNull());
    await act(async () => {
      result.current.mudar({ iniciarComSistema: true });
      await Promise.resolve();
    });
    expect(ponte.salvarAjustes).toHaveBeenCalledWith({ iniciarComSistema: true });
    expect(result.current.ajustes?.iniciarComSistema).toBe(false);
    expect(result.current.autostartFalhou).toBe(true);
  });
});
