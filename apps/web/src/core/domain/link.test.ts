import { describe, expect, it } from 'vitest';
import { linkDoCanal } from './link.js';

describe('link do canal (ADR 0026)', () => {
  it('é só o nome, sem segredo no fragmento', () => {
    expect(linkDoCanal('https://tela.gg', 'jv')).toBe('https://tela.gg/jv');
  });
});
