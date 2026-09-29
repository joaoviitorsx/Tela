import { describe, expect, it } from 'vitest';
import { conviteDoFragmento, linkComConvite } from './convite.js';

const K = 'AbC_-0123456789abcdefgh';

describe('convite no link', () => {
  it('ida e volta pelo fragmento', () => {
    const link = linkComConvite('https://tela.gg', 'jv', K);
    expect(link).toBe(`https://tela.gg/jv#k=${K}`);
    expect(conviteDoFragmento(new URL(link).hash)).toBe(K);
  });

  it('ausente, vazio ou fora do formato é null', () => {
    for (const f of ['', '#', '#k=', '#k=curto', '#x=' + K, `#k=${K}!`]) {
      expect(conviteDoFragmento(f)).toBeNull();
    }
  });
});
