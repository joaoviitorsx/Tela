// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ResultadoBrutoSonda, SondaDeRede } from '../core/ports/sonda-de-rede.js';
import { BLOCOS_DO_TESTE, medidaDaConexaoDireta, useTesteDeRede } from './use-teste-de-rede.js';

function sondaFalsa(resultado: ResultadoBrutoSonda) {
  let soltar!: () => void;
  const portao = new Promise<void>((r) => { soltar = r; });
  let chamadas = 0;
  const sonda: SondaDeRede = {
    async testar(aoProgresso) {
      chamadas += 1;
      aoProgresso(0.5);
      await portao;
      aoProgresso(1);
      return resultado;
    },
  };
  return { sonda, soltar: () => soltar(), chamadas: () => chamadas };
}

describe('useTesteDeRede', () => {
  it('anda a barra, conclui, e não dispara dois testes juntos', async () => {
    const f = sondaFalsa({
      candidatos: [{ tipo: 'host', portaPublica: null }, { tipo: 'srflx', portaPublica: 4000 }],
      primeiraRespostaMs: 40, erro: null,
    });
    const { result } = renderHook(() => useTesteDeRede(f.sonda));
    expect(medidaDaConexaoDireta(result.current).valor).toBe('— —');
    act(() => { result.current.testar(); result.current.testar(); });
    expect(result.current.fase).toBe('testando');
    expect(result.current.blocos).toBe(BLOCOS_DO_TESTE / 2);
    await act(async () => { f.soltar(); await Promise.resolve(); });
    expect(result.current.fase).toBe('pronto');
    expect(f.chamadas()).toBe(1);
    expect(medidaDaConexaoDireta(result.current)).toMatchObject({ valor: 'PROVÁVEL', tom: 'ok' });
  });
});
