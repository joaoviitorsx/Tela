import { describe, expect, it } from 'vitest';
import { FakeStorage } from '../testing/fakes.js';
import { APROVADOS_KEY, makeAprovados } from './aprovados.js';

describe('aprovados do dono (ADR 0025)', () => {
  it('lembra, revoga e zera', () => {
    const storage = new FakeStorage();
    const a = makeAprovados(storage);
    a.aprovar('f1');
    a.aprovar('f2');
    expect(makeAprovados(storage).tem('f1')).toBe(true);
    a.revogar('f1');
    expect(a.tem('f1')).toBe(false);
    expect(a.tem('f2')).toBe(true);
    a.limpar();
    expect(a.tem('f2')).toBe(false);
  });

  it('armazenamento corrompido vale como lista vazia', () => {
    const storage = new FakeStorage();
    storage.set(APROVADOS_KEY, '{nao é json');
    expect(makeAprovados(storage).tem('x')).toBe(false);
  });

  it('tem teto: sai o mais antigo', () => {
    const a = makeAprovados(new FakeStorage());
    for (let i = 0; i < 70; i += 1) a.aprovar(`f${i}`);
    expect(a.tem('f0')).toBe(false);
    expect(a.tem('f69')).toBe(true);
  });
});
