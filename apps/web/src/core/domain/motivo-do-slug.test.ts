import { describe, expect, it } from 'vitest';
import { motivoDoSlugInvalido } from './motivo-do-slug.js';

describe('motivoDoSlugInvalido', () => {
  it.each([
    ['joao', null],
    ['a1b', null],
    ['-ab', 'Não pode começar com hífen.'],
    ['ab-', 'Não pode terminar com hífen.'],
    ['ab', 'Falta 1 caractere (mínimo 3).'],
    ['a', 'Faltam 2 caracteres (mínimo 3).'],
    ['joão', 'Só letras, números e hífen.'],
    ['jo ao', 'Só letras, números e hífen.'],
    ['x'.repeat(26), 'No máximo 25 caracteres.'],
  ])('%s', (entrada, frase) => {
    expect(motivoDoSlugInvalido(entrada)).toBe(frase);
  });

  it('normaliza caixa como o resto do fluxo', () => {
    expect(motivoDoSlugInvalido('JOAO')).toBeNull();
  });
});
