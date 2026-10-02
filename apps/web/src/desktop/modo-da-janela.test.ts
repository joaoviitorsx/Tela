import { describe, expect, it, vi } from 'vitest';
import { criarModoDaJanela } from './modo-da-janela.js';
import type { ModoDaJanela } from './ponte.js';

function ponteFalsa() {
  let ouvinte: ((m: ModoDaJanela) => void) | null = null;
  return {
    aoMudarModo: vi.fn((o: (m: ModoDaJanela) => void) => {
      ouvinte = o;
      return () => undefined;
    }),
    pedirModo: vi.fn(),
    avisar: (m: ModoDaJanela) => ouvinte?.(m),
  };
}

describe('criarModoDaJanela', () => {
  it('nasce normal e segue o que o main diz', () => {
    const ponte = ponteFalsa();
    const modo = criarModoDaJanela(ponte);
    const ouvinte = vi.fn();
    modo.assinar(ouvinte);
    expect(modo.atual()).toBe('normal');
    ponte.avisar('compacto');
    expect(modo.atual()).toBe('compacto');
    expect(ouvinte).toHaveBeenCalledTimes(1);
    ponte.avisar('compacto');
    expect(ouvinte).toHaveBeenCalledTimes(1);
  });
  it('pedir só repassa: quem decide é o main', () => {
    const ponte = ponteFalsa();
    const modo = criarModoDaJanela(ponte);
    modo.pedir('compacto');
    expect(ponte.pedirModo).toHaveBeenCalledWith('compacto');
    expect(modo.atual()).toBe('normal');
  });
});
