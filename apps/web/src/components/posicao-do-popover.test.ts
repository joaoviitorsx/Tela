import { describe, expect, it } from 'vitest';
import { posicaoDoPopover } from './posicao-do-popover.js';

describe('posicaoDoPopover', () => {
  it('fica 4px abaixo do botão, com a borda direita alinhada à dele', () => {
    expect(posicaoDoPopover({ bottom: 100, right: 1300 }, 1400)).toEqual({ topo: 104, direita: 100 });
  });

  it('nunca encosta na borda da janela', () => {
    expect(posicaoDoPopover({ bottom: 50, right: 1400 }, 1400).direita).toBe(8);
  });
});
