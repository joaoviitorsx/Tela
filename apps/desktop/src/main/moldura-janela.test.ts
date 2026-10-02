import { describe, expect, it } from 'vitest';
import {
  ALTURA_DA_BARRA,
  COR_DA_BARRA,
  decidirAcaoDeJanela,
  estadoDaJanela,
  opcoesDeMoldura,
  pedidoSemCarga,
} from './moldura-janela.js';

const NORMAL = { modoCompacto: false, maximizada: false, telaCheia: false };

describe('opcoesDeMoldura', () => {
  it('Windows: barra escondida com overlay nativo, na cor e na altura da barra', () => {
    expect(opcoesDeMoldura('win32')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: COR_DA_BARRA, symbolColor: '#f2a93b', height: ALTURA_DA_BARRA },
    });
  });
  it('Linux: sem moldura (a página desenha os botões)', () => {
    expect(opcoesDeMoldura('linux')).toEqual({ frame: false });
  });
  it('macOS (não é alvo): padrão', () => {
    expect(opcoesDeMoldura('darwin')).toEqual({});
  });
  it('a cor do overlay é a do bg-void', () => {
    expect(COR_DA_BARRA).toBe('#0b0c0e');
  });
});

describe('decidirAcaoDeJanela', () => {
  it('minimizar e fechar sempre valem; fechar não decide nada além de fechar', () => {
    expect(decidirAcaoDeJanela('minimizar', NORMAL)).toBe('minimizar');
    expect(decidirAcaoDeJanela('fechar', { ...NORMAL, modoCompacto: true })).toBe('fechar');
  });
  it('maximizar alterna com restaurar', () => {
    expect(decidirAcaoDeJanela('alternar-maximizar', NORMAL)).toBe('maximizar');
    expect(decidirAcaoDeJanela('alternar-maximizar', { ...NORMAL, maximizada: true })).toBe('restaurar');
  });
  it('no compacto e em tela cheia não há maximizar', () => {
    expect(decidirAcaoDeJanela('alternar-maximizar', { ...NORMAL, modoCompacto: true })).toBe('ignorar');
    expect(decidirAcaoDeJanela('alternar-maximizar', { ...NORMAL, telaCheia: true })).toBe('ignorar');
  });
});

describe('pedidoSemCarga e estadoDaJanela', () => {
  it('só aceita pedido sem argumentos', () => {
    expect(pedidoSemCarga([])).toBe(true);
    expect(pedidoSemCarga([{ x: 1 }])).toBe(false);
    expect(pedidoSemCarga([undefined])).toBe(false);
  });
  it('lê foco, maximizada e tela cheia', () => {
    expect(estadoDaJanela({ isFocused: () => true, isMaximized: () => false, isFullScreen: () => true })).toEqual({
      focada: true,
      maximizada: false,
      telaCheia: true,
    });
  });
});
