import { describe, expect, it } from 'vitest';
import { FakeStorage } from '../testing/fakes.js';
import { MAX_RECENTES, RECENTES_KEY, makeCanaisRecentes } from './canais-recentes.js';

describe('canais recentes', () => {
  it('o último assistido vem primeiro, sem repetir', () => {
    const r = makeCanaisRecentes(new FakeStorage());
    r.lembrar('ana');
    r.lembrar('bia');
    r.lembrar('ana');
    expect(r.listar()).toEqual(['ana', 'bia']);
  });

  it('guarda no máximo seis', () => {
    const r = makeCanaisRecentes(new FakeStorage());
    for (const c of ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg']) r.lembrar(c);
    expect(r.listar()).toHaveLength(MAX_RECENTES);
    expect(r.listar()[0]).toBe('ggg');
  });

  it('lixo no armazenamento vira lista vazia, e nome inválido não entra', () => {
    const storage = new FakeStorage();
    storage.set(RECENTES_KEY, '{quebrado');
    const r = makeCanaisRecentes(storage);
    expect(r.listar()).toEqual([]);
    storage.set(RECENTES_KEY, JSON.stringify(['ana', 42, 'NÃO', 'bia']));
    expect(r.listar()).toEqual(['ana', 'bia']);
    r.lembrar('x');
    expect(r.listar()).toEqual(['ana', 'bia']);
  });
});
