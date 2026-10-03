import { describe, expect, it } from 'vitest';
import { PASSO_MAXIMO_MS, proximosAtrasos } from './sincronia.js';

describe('proximosAtrasos', () => {
  it('atrasa só o mais rápido, até o mais lento, em passos', () => {
    let atuais: readonly [number, number] = [0, 0];
    const naturais = [100, 250] as const;
    for (let i = 0; i < 10; i += 1) atuais = proximosAtrasos(naturais, atuais, 400);
    expect(atuais).toEqual([150, 0]);
    expect(proximosAtrasos(naturais, [0, 0], 400)).toEqual([PASSO_MAXIMO_MS, 0]);
  });

  it('diferença pequena não mexe (zona morta)', () => {
    expect(proximosAtrasos([100, 115], [0, 0], 400)).toEqual([0, 0]);
  });

  it('sem medida de um dos dois, segura', () => {
    expect(proximosAtrasos([null, 200], [80, 0], 400)).toEqual([80, 0]);
  });

  it('respeita o teto', () => {
    let atuais: readonly [number, number] = [0, 0];
    for (let i = 0; i < 20; i += 1) atuais = proximosAtrasos([50, 900], atuais, 400);
    expect(atuais).toEqual([400, 0]);
  });

  it('quando o outro melhora, devolve o atraso', () => {
    let atuais: readonly [number, number] = [150, 0];
    for (let i = 0; i < 10; i += 1) atuais = proximosAtrasos([100, 110], atuais, 400);
    // O desejado é 10 ms; para dentro da zona morta em volta dele.
    expect(Math.abs(atuais[0] - 10)).toBeLessThan(25);
  });
});
