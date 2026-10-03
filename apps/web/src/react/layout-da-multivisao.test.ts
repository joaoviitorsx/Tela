import { describe, expect, it } from 'vitest';
import { posicaoDoPainel } from './layout-da-multivisao.js';

const base = { canto: 'inf-dir', tamanho: 'm', folgaDaBarra: 0, indice: 0 } as const;

describe('posicaoDoPainel', () => {
  it('sozinho e a principal do PiP ocupam o palco', () => {
    expect(posicaoDoPainel({ ...base, arranjo: 'sozinho', principal: true }).classe).toBe('absolute inset-0');
    expect(posicaoDoPainel({ ...base, arranjo: 'pip', principal: true }).classe).toBe('absolute inset-0');
  });

  it('a secundária do PiP fica no canto, acima do vidro do CRT', () => {
    const p = posicaoDoPainel({ ...base, arranjo: 'pip', principal: false });
    expect(p.classe).toContain('bottom-');
    expect(p.classe).toContain('right-');
    expect(p.classe).toContain('z-[41]');
    expect(p.estilo.width).toContain('24%');
  });

  it('no canto de baixo, sobe a altura da barra; no de cima, não', () => {
    const baixo = posicaoDoPainel({ ...base, arranjo: 'pip', principal: false, folgaDaBarra: 100 });
    expect(baixo.estilo.translate).toBe('0 -100px');
    const cima = posicaoDoPainel({ ...base, arranjo: 'pip', principal: false, folgaDaBarra: 100, canto: 'sup-esq' });
    expect(cima.estilo.translate).toBe('0 0');
  });

  it('lado a lado e empilhado: a metade é a da ORDEM dos canais, não do papel', () => {
    expect(posicaoDoPainel({ ...base, arranjo: 'lado-a-lado', principal: false, indice: 0 }).classe).toContain('left-0');
    expect(posicaoDoPainel({ ...base, arranjo: 'lado-a-lado', principal: true, indice: 1 }).classe).toContain('right-0');
    expect(posicaoDoPainel({ ...base, arranjo: 'empilhado', principal: true, indice: 1 }).classe).toContain('bottom-0');
  });
});
