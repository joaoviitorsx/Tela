// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { criarPainelDiagnostico, useDiagnosticoAberto } from './painel-diagnostico.js';

afterEach(cleanup);

describe('painel DIAGNÓSTICO', () => {
  it('abre e fecha, avisando só quando o valor muda', () => {
    const painel = criarPainelDiagnostico();
    const ouvinte = vi.fn();
    painel.assinar(ouvinte);
    painel.abrir();
    painel.abrir();
    painel.fechar();
    expect(ouvinte).toHaveBeenCalledTimes(2);
  });

  it('dois hooks no mesmo painel concordam (trilho e rota)', () => {
    const painel = criarPainelDiagnostico();
    const trilho = renderHook(() => useDiagnosticoAberto(painel));
    const rota = renderHook(() => useDiagnosticoAberto(painel));
    act(() => trilho.result.current.abrir());
    expect(rota.result.current.aberto).toBe(true);
    act(() => rota.result.current.fechar());
    expect(trilho.result.current.aberto).toBe(false);
  });
});
