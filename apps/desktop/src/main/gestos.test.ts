import { describe, expect, it } from 'vitest';
import { criarPortaoDeGesto, ehGesto, VALIDADE_DO_GESTO_MS } from './gestos.js';

describe('gesto do usuário (S-05)', () => {
  it('clique e tecla contam; mover, rolar e entrar na janela não', () => {
    for (const t of ['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'touchStart']) expect(ehGesto(t), t).toBe(true);
    for (const t of ['mouseMove', 'mouseWheel', 'mouseEnter', 'mouseLeave', 'contextMenu', 'keyUp', '']) {
      expect(ehGesto(t), t).toBe(false);
    }
  });

  it('sem gesto, recusa; com gesto, aceita só dentro da validade', () => {
    let t = 1000;
    const p = criarPortaoDeGesto(() => t);
    expect(p.recente(1)).toBe(false);
    p.registrar(1);
    expect(p.recente(1)).toBe(true);
    t += VALIDADE_DO_GESTO_MS;
    expect(p.recente(1)).toBe(true);
    t += 1;
    expect(p.recente(1)).toBe(false);
  });

  it('o gesto é por conteúdo: o de uma janela não vale para outra', () => {
    const p = criarPortaoDeGesto(() => 0);
    p.registrar(1);
    expect(p.recente(1)).toBe(true);
    expect(p.recente(2)).toBe(false);
    p.esquecer(1);
    expect(p.recente(1)).toBe(false);
  });

  it('um relógio que anda para trás não vale como "recente"', () => {
    let t = 500;
    const p = criarPortaoDeGesto(() => t);
    p.registrar(1);
    t = 100;
    expect(p.recente(1)).toBe(false);
  });
});
