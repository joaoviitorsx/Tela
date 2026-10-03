// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FonteDeCaptura } from './ponte.js';
import { makeSeletorDeFontes } from './seletor-de-fontes.js';
import { useSeletorDeFontes } from './use-seletor-de-fontes.js';

afterEach(cleanup);

const LOL: FonteDeCaptura = { id: 'window:9:0', nome: 'League of Legends (TM) Client', tipo: 'janela', miniatura: null, icone: null };
const TELA: FonteDeCaptura = { id: 'screen:0:0', nome: 'TELA INTEIRA', tipo: 'tela', miniatura: null, icone: null };
const tique = () => act(() => new Promise((r) => setTimeout(r, 0)));

/** Loja de verdade; cada `proxima` decide o que a listagem devolve; o timer dispara à mão. */
function montar() {
  let proxima: readonly FonteDeCaptura[] = [];
  const timers: (() => void)[] = [];
  const seletor = makeSeletorDeFontes({
    listar: async () => proxima,
    agendar: (fn) => {
      timers.push(fn);
      return () => undefined;
    },
  });
  const listar = (f: readonly FonteDeCaptura[]) => {
    proxima = f;
  };
  const rodarTimer = async () => {
    timers.shift()?.();
    await tique();
  };
  return { seletor, listar, rodarTimer };
}

describe('useSeletorDeFontes — aviso do cursor do LoL', () => {
  it('visto uma vez, fica até fechar, mesmo com a listagem voltando vazia (portão de gesto)', async () => {
    const { seletor, listar, rodarTimer } = montar();
    const { result } = renderHook(() => useSeletorDeFontes(seletor, 'win32'));
    listar([TELA, LOL]);
    act(() => void seletor.abrir());
    await tique();
    expect(result.current.avisoDoJogo).toMatch(/Sem bordas/);
    listar([]);
    await rodarTimer();
    expect(result.current.estado.fontes).toEqual([]);
    expect(result.current.avisoDoJogo).toMatch(/Sem bordas/);
  });

  it('abrir por cima de outra abertura não herda o aviso da anterior', async () => {
    const { seletor, listar } = montar();
    const { result } = renderHook(() => useSeletorDeFontes(seletor, 'win32'));
    listar([TELA, LOL]);
    act(() => void seletor.abrir());
    await tique();
    expect(result.current.avisoDoJogo).not.toBeNull();
    listar([TELA]);
    act(() => void seletor.abrir());
    expect(result.current.avisoDoJogo).toBeNull();
    await tique();
    expect(result.current.avisoDoJogo).toBeNull();
  });

  it('fechar zera', async () => {
    const { seletor, listar } = montar();
    const { result } = renderHook(() => useSeletorDeFontes(seletor, 'win32'));
    listar([LOL]);
    act(() => void seletor.abrir());
    await tique();
    expect(result.current.avisoDoJogo).not.toBeNull();
    act(() => seletor.cancelar());
    expect(result.current.avisoDoJogo).toBeNull();
  });

  it('fora do Windows nunca avisa', async () => {
    const { seletor, listar } = montar();
    const { result } = renderHook(() => useSeletorDeFontes(seletor, 'linux'));
    listar([LOL]);
    act(() => void seletor.abrir());
    await tique();
    expect(result.current.avisoDoJogo).toBeNull();
  });
});
