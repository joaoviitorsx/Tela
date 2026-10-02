import { describe, expect, it } from 'vitest';
import {
  estadoAoVivoValido,
  FORA_DO_AR,
  mesmoEstado,
  modeloDoMenu,
  rotuloDoEstado,
  tempoNoAr,
} from './estado-ao-vivo.js';

const NO_AR = { noAr: true, inicioMs: 1_000_000, assistindo: 3, capacidade: 50, link: 'https://tela.gg/jv' };

describe('estadoAoVivoValido', () => {
  it('aceita um estado ao vivo completo', () => {
    expect(estadoAoVivoValido(NO_AR)).toEqual({ ...NO_AR, link: 'https://tela.gg/jv' });
  });
  it('fora do ar vira FORA_DO_AR, sem herdar lixo', () => {
    expect(estadoAoVivoValido({ ...NO_AR, noAr: false })).toBe(FORA_DO_AR);
  });
  it('recusa o que não é estado', () => {
    for (const ruim of [null, undefined, 'x', 3, [], {}, { noAr: 'sim' }]) expect(estadoAoVivoValido(ruim)).toBeNull();
  });
  it('recusa números fora de faixa ou não inteiros', () => {
    for (const campo of ['assistindo', 'capacidade'] as const) {
      for (const v of [-1, 1.5, NaN, Infinity, 1001, '3', null]) {
        expect(estadoAoVivoValido({ ...NO_AR, [campo]: v })).toBeNull();
      }
    }
    for (const v of [0, -5, NaN, '1', Infinity]) expect(estadoAoVivoValido({ ...NO_AR, inicioMs: v })).toBeNull();
  });
  it('inicioMs e link podem ser null; link só http(s) — é só copiado, nunca aberto', () => {
    expect(estadoAoVivoValido({ ...NO_AR, inicioMs: null, link: null })).toMatchObject({ inicioMs: null, link: null });
    expect(estadoAoVivoValido({ ...NO_AR, link: 'http://localhost:5173/jv' })?.link).toBe('http://localhost:5173/jv');
    for (const l of ['ftp://tela.gg/jv', 'javascript:alert(1)', 'file:///etc/passwd', 'app://tela/x', 7, `https://x/${'a'.repeat(3000)}`]) {
      expect(estadoAoVivoValido({ ...NO_AR, link: l })).toBeNull();
    }
  });
  it('mesmoEstado só é verdadeiro para estados iguais', () => {
    expect(mesmoEstado(NO_AR, { ...NO_AR })).toBe(true);
    expect(mesmoEstado(NO_AR, { ...NO_AR, assistindo: 4 })).toBe(false);
    expect(mesmoEstado(FORA_DO_AR, FORA_DO_AR)).toBe(true);
  });
});

describe('rótulos e menu', () => {
  it('tempo mm:ss e h:mm:ss', () => {
    expect(tempoNoAr(1_000_000, 1_042_000)).toBe('00:42');
    expect(tempoNoAr(0 + 1, 1 + 3_725_000)).toBe('1:02:05');
    expect(tempoNoAr(null, 5)).toBe('--:--');
    expect(tempoNoAr(5000, 1000)).toBe('00:00');
  });
  it('o estado em uma linha', () => {
    expect(rotuloDoEstado(NO_AR, 1_042_000)).toBe('NO AR 00:42 · 3/50');
    expect(rotuloDoEstado(FORA_DO_AR, 0)).toBe('Fora do ar');
  });
  it('fora do ar: copiar e encerrar desabilitados', () => {
    const itens = modeloDoMenu(FORA_DO_AR, true, 0).filter((i) => i.tipo === 'item');
    const por = (id: string) => itens.find((i) => i.id === id);
    expect(por('copiar')?.habilitado).toBe(false);
    expect(por('encerrar')?.habilitado).toBe(false);
    expect(por('mostrar')?.rotulo).toBe('Esconder');
    expect(por('sair')?.rotulo).toBe('Sair');
  });
  it('ao vivo e escondida: copiar, encerrar e Mostrar', () => {
    const itens = modeloDoMenu(NO_AR, false, 1_042_000).filter((i) => i.tipo === 'item');
    const por = (id: string) => itens.find((i) => i.id === id);
    expect(por('estado')?.rotulo).toBe('NO AR 00:42 · 3/50');
    expect(por('copiar')?.habilitado).toBe(true);
    expect(por('encerrar')?.habilitado).toBe(true);
    expect(por('mostrar')?.rotulo).toBe('Mostrar');
    expect(por('sair')?.rotulo).toMatch(/encerra a transmissão/);
  });
});
