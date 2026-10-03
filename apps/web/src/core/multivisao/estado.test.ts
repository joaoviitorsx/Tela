import { describe, expect, it } from 'vitest';
import {
  adicionar,
  alternarLayout,
  cantoMaisPerto,
  focar,
  iniciarMultivisao,
  moverPip,
  ordemDoLink,
  pausar,
  proximoTamanho,
  redimensionar,
  remover,
  retomar,
  secundaria,
  trocar,
} from './estado.js';

const dois = () => iniciarMultivisao(['ana', 'bia']);

describe('multivisão', () => {
  it('nasce com o primeiro do link como principal, em PiP', () => {
    const e = dois();
    expect(e.principal).toBe('ana');
    expect(secundaria(e)).toBe('bia');
    expect(e.layout).toBe('pip');
    expect(e.canto).toBe('inf-dir');
  });

  it('trocar muda a principal SEM reordenar os canais (o DOM não se mexe)', () => {
    const e = trocar(dois());
    expect(e.principal).toBe('bia');
    expect(e.canais).toEqual(['ana', 'bia']);
    expect(ordemDoLink(e)).toEqual(['bia', 'ana']);
    expect(trocar(e).principal).toBe('ana');
  });

  it('com um canal só, trocar não faz nada', () => {
    const e = iniciarMultivisao(['ana']);
    expect(trocar(e)).toBe(e);
  });

  it('adicionar o segundo; repetido é erro', () => {
    const um = iniciarMultivisao(['ana']);
    const r = adicionar(um, 'bia');
    expect(r.ok && r.value.canais).toEqual(['ana', 'bia']);
    expect(adicionar(um, 'ana')).toEqual({ ok: false, error: 'CANAL_REPETIDO' });
  });

  it('cheio, o novo entra no lugar da secundária, na mesma posição', () => {
    const r = adicionar(trocar(dois()), 'caio');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.principal).toBe('bia');
    expect(r.value.canais).toEqual(['caio', 'bia']);
  });

  it('remover a principal promove a outra; o último não sai', () => {
    const e = remover(dois(), 'ana');
    expect(e.principal).toBe('bia');
    expect(e.canais).toEqual(['bia']);
    expect(remover(e, 'bia')).toBe(e);
  });

  it('pausa só a secundária, e quem vira principal sai da pausa', () => {
    const p = pausar(dois(), 'rede');
    expect(p.pausada).toEqual({ canal: 'bia', motivo: 'rede' });
    expect(focar(p, 'bia').pausada).toBeNull();
    expect(retomar(p).pausada).toBeNull();
    expect(pausar(iniciarMultivisao(['ana']), 'rede').pausada).toBeNull();
  });

  it('remover a pausada limpa a pausa', () => {
    expect(remover(pausar(dois(), 'rede'), 'bia').pausada).toBeNull();
  });

  it('layout, canto e tamanho', () => {
    expect(alternarLayout(dois()).layout).toBe('lado-a-lado');
    expect(moverPip(dois(), 'sup-esq').canto).toBe('sup-esq');
    expect(redimensionar(dois(), 1).tamanho).toBe('g');
    expect(redimensionar(redimensionar(dois(), 1), 1).tamanho).toBe('g');
    expect(redimensionar(redimensionar(dois(), -1), -1).tamanho).toBe('p');
    expect(proximoTamanho(dois()).tamanho).toBe('g');
    expect(proximoTamanho(proximoTamanho(dois())).tamanho).toBe('p');
  });

  it('o canto mais perto de onde a PiP foi solta', () => {
    expect(cantoMaisPerto(0.9, 0.9)).toBe('inf-dir');
    expect(cantoMaisPerto(0.1, 0.1)).toBe('sup-esq');
    expect(cantoMaisPerto(0.2, 0.8)).toBe('inf-esq');
    expect(cantoMaisPerto(0.8, 0.2)).toBe('sup-dir');
  });
});
