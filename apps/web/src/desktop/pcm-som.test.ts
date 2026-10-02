import { describe, expect, it } from 'vitest';
import { blocoValido } from './pcm-som.js';

describe('blocoValido', () => {
  it('aceita um bloco de 10 ms', () => {
    const dados = new Float32Array(960);
    expect(blocoValido({ t: 'pcm', n: 3, dados })).toEqual({ t: 'pcm', n: 3, dados });
  });

  it('recusa o que não é um bloco: tipo, tamanho ímpar, vazio, enorme', () => {
    const ruins: unknown[] = [
      null,
      'pcm',
      { t: 'pcm', n: 1 },
      { t: 'x', n: 1, dados: new Float32Array(2) },
      { t: 'pcm', n: '1', dados: new Float32Array(2) },
      { t: 'pcm', n: 1, dados: new Float64Array(2) },
      { t: 'pcm', n: 1, dados: [0, 0] },
      { t: 'pcm', n: 1, dados: new Float32Array(0) },
      { t: 'pcm', n: 1, dados: new Float32Array(3) },
      { t: 'pcm', n: 1, dados: new Float32Array(48_000 * 2 + 2) },
    ];
    for (const r of ruins) expect(blocoValido(r)).toBeNull();
  });
});
