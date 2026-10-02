import { describe, expect, it } from 'vitest';
import { MOTIVOS_DE_QUEDA, motivoDaQueda, TEXTO_DA_QUEDA } from './queda.js';

describe('motivoDaQueda', () => {
  it('sem o parâmetro, não é uma recuperação', () => {
    expect(motivoDaQueda('')).toBeNull();
    expect(motivoDaQueda('?outra=1')).toBeNull();
  });
  it('lê um motivo conhecido', () => {
    expect(motivoDaQueda('?queda=oom')).toBe('oom');
  });
  it('um valor desconhecido ainda é uma queda — e nunca vira texto da URL', () => {
    expect(motivoDaQueda('?queda=<img>')).toBe('crashed');
  });
  it('todo motivo tem texto', () => {
    for (const m of MOTIVOS_DE_QUEDA) expect(TEXTO_DA_QUEDA[m].length).toBeGreaterThan(10);
  });
});
