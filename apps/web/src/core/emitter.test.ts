import { describe, expect, it } from 'vitest';
import { Emitter } from './emitter.js';

describe('Emitter', () => {
  it('entrega o payload a quem assinou', () => {
    const emitter = new Emitter<{ tick: number }>();
    const seen: number[] = [];
    emitter.on('tick', (n) => seen.push(n));
    emitter.emit('tick', 1);
    emitter.emit('tick', 2);
    expect(seen).toEqual([1, 2]);
  });

  it('a função devolvida cancela a assinatura', () => {
    const emitter = new Emitter<{ tick: number }>();
    const seen: number[] = [];
    const off = emitter.on('tick', (n) => seen.push(n));
    emitter.emit('tick', 1);
    off();
    emitter.emit('tick', 2);
    expect(seen).toEqual([1]);
  });

  it('listener que se remove durante o emit não corrompe a iteração', () => {
    const emitter = new Emitter<{ tick: number }>();
    const seen: string[] = [];
    const off = emitter.on('tick', () => {
      seen.push('a');
      off();
    });
    emitter.on('tick', () => seen.push('b'));
    emitter.emit('tick', 1);
    expect(seen).toEqual(['a', 'b']);
  });

  it('emitir evento sem ouvinte não quebra', () => {
    const emitter = new Emitter<{ tick: number }>();
    expect(() => emitter.emit('tick', 1)).not.toThrow();
  });

  it('clear remove todos', () => {
    const emitter = new Emitter<{ tick: number }>();
    const seen: number[] = [];
    emitter.on('tick', (n) => seen.push(n));
    emitter.clear();
    emitter.emit('tick', 1);
    expect(seen).toEqual([]);
  });
});
