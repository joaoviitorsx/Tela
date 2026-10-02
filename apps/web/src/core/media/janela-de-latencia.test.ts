import { describe, expect, it } from 'vitest';
import {
  JanelaDeLatencia,
  MINIMO_PARA_CAPTURA,
  QUADROS_DA_JANELA,
  percentil,
} from './janela-de-latencia.js';

describe('JanelaDeLatencia', () => {
  it('vazia não tem resumo', () => {
    expect(new JanelaDeLatencia().resumo()).toBeNull();
  });

  it('mediana e p95 de 1..100', () => {
    const j = new JanelaDeLatencia();
    for (let i = 1; i <= 100; i += 1) j.registrar(i, 'captura');
    const r = j.resumo();
    expect(r?.mediana).toBe(50.5);
    expect(r?.p95).toBe(95);
    expect(r?.amostras).toBe(100);
  });

  it('um pico isolado não move a mediana, mas aparece no p95 só se for frequente', () => {
    const j = new JanelaDeLatencia();
    for (let i = 0; i < 119; i += 1) j.registrar(40, 'captura');
    j.registrar(3_000, 'captura');
    expect(j.resumo()?.mediana).toBe(40);
    expect(j.resumo()?.p95).toBe(40);
  });

  it('janela deslizante: só os últimos quadros contam', () => {
    const j = new JanelaDeLatencia();
    for (let i = 0; i < QUADROS_DA_JANELA; i += 1) j.registrar(500, 'captura');
    for (let i = 0; i < QUADROS_DA_JANELA; i += 1) j.registrar(50, 'captura');
    expect(j.resumo()?.mediana).toBe(50);
    expect(j.resumo()?.amostras).toBe(QUADROS_DA_JANELA);
  });

  it('descarta valores impossíveis', () => {
    const j = new JanelaDeLatencia();
    for (const x of [-1, Number.NaN, Number.POSITIVE_INFINITY, 31_000]) j.registrar(x, 'captura');
    expect(j.resumo()).toBeNull();
  });

  it('captura manda sobre recepção só com amostras suficientes', () => {
    const j = new JanelaDeLatencia();
    for (let i = 0; i < 60; i += 1) j.registrar(20, 'recepcao');
    for (let i = 0; i < MINIMO_PARA_CAPTURA - 1; i += 1) j.registrar(90, 'captura');
    expect(j.resumo()?.origem).toBe('recepcao');
    j.registrar(90, 'captura');
    expect(j.resumo()).toMatchObject({ origem: 'captura', mediana: 90 });
  });

  it('captura que some não fica mandando com amostra velha', () => {
    const j = new JanelaDeLatencia();
    for (let i = 0; i < 60; i += 1) j.registrar(90, 'captura');
    for (let i = 0; i < QUADROS_DA_JANELA; i += 1) j.registrar(20, 'recepcao');
    expect(j.resumo()).toMatchObject({ origem: 'recepcao', mediana: 20 });
  });

  it('percentil', () => {
    expect(percentil([], 0.95)).toBeNull();
    expect(percentil([7], 0.95)).toBe(7);
  });
});
