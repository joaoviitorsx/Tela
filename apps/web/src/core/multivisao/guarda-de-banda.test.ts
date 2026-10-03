import { describe, expect, it } from 'vitest';
import { GuardaDeBanda } from './guarda-de-banda.js';

describe('GuardaDeBanda', () => {
  it('fluido não pausa', () => {
    const g = new GuardaDeBanda(4_000, 15_000);
    for (let t = 0; t < 20_000; t += 1_000) expect(g.observar(t, [null, null])).toBeNull();
  });

  it('lentidão sustentada pausa; um soluço não', () => {
    const g = new GuardaDeBanda(4_000, 15_000);
    expect(g.observar(0, ['rede', null])).toBeNull();
    expect(g.observar(2_000, ['rede', null])).toBeNull();
    expect(g.observar(3_000, [null, null])).toBeNull();
    expect(g.observar(4_000, [null, 'rede'])).toBeNull();
    expect(g.observar(8_000, [null, 'rede'])).toBe('rede');
  });

  it('rede vence decodificação', () => {
    const g = new GuardaDeBanda(1_000, 0);
    g.observar(0, ['decodificacao', 'rede']);
    expect(g.observar(1_000, ['decodificacao', 'rede'])).toBe('rede');
    const h = new GuardaDeBanda(1_000, 0);
    h.observar(0, ['decodificacao']);
    expect(h.observar(1_000, ['decodificacao'])).toBe('decodificacao');
  });

  it('depois do RETOMAR há carência', () => {
    const g = new GuardaDeBanda(1_000, 15_000);
    g.retomou(0);
    expect(g.observar(1_000, ['rede'])).toBeNull();
    expect(g.observar(14_000, ['rede'])).toBeNull();
    expect(g.observar(15_000, ['rede'])).toBe('rede');
  });
});
