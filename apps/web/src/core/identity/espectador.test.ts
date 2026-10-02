import { describe, expect, it } from 'vitest';
import { FakeRandom, FakeStorage } from '../testing/fakes.js';
import { APELIDO_KEY, CHAVE_ESPECTADOR_KEY, apelidoValido, makeEspectador } from './espectador.js';

describe('espectador (ADR 0025)', () => {
  it('a chave nasce uma vez e é a mesma depois — é o que faz a aprovação valer na volta', () => {
    const storage = new FakeStorage();
    const primeira = makeEspectador(storage, new FakeRandom()).chave();
    expect(primeira).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(makeEspectador(storage, new FakeRandom()).chave()).toBe(primeira);
    expect(storage.get(CHAVE_ESPECTADOR_KEY)).toBe(primeira);
  });

  it('apelido: aparado, até 24, limpo de controle (o schema do shared limpa em vez de recusar)', () => {
    expect(apelidoValido('  ana  ')).toBe('ana');
    expect(apelidoValido('')).toBeNull();
    expect(apelidoValido('   ')).toBeNull();
    expect(apelidoValido('x'.repeat(25))).toBeNull();
    // Quebra de linha vira espaço; só invisível não é nome (S-20).
    expect(apelidoValido('a\nb')).toBe('a b');
    expect(apelidoValido('\u200b')).toBeNull();
    expect(apelidoValido('João 🎮')).toBe('João 🎮');
  });

  it('só guarda apelido válido', () => {
    const storage = new FakeStorage();
    const e = makeEspectador(storage, new FakeRandom());
    expect(e.lembrarApelido('')).toBeNull();
    expect(e.apelido()).toBeNull();
    expect(e.lembrarApelido(' bia ')).toBe('bia');
    expect(storage.get(APELIDO_KEY)).toBe('bia');
    expect(e.apelido()).toBe('bia');
  });
});
