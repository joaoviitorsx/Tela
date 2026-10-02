import { describe, expect, it } from 'vitest';
import { buildDoWindows, pedidoDeJogoValido, windowsSuportaLoopbackPorProcesso } from './protocolo-som.js';

describe('pedidoDeJogoValido', () => {
  it('aceita só um id de app na forma conhecida', () => {
    expect(pedidoDeJogoValido('pid:42')).toBe('pid:42');
    expect(pedidoDeJogoValido('app:Jogo|jogo')).toBe('app:Jogo|jogo');
    for (const ruim of [undefined, null, 42, {}, 'rm -rf', 'pid:', '']) expect(pedidoDeJogoValido(ruim)).toBeNull();
  });
});

describe('windowsSuportaLoopbackPorProcesso', () => {
  it.each([
    ['10.0.19041', true],
    ['10.0.19045', true],
    ['10.0.22631', true],
    ['10.0.18363', false],
    ['10.0.17763', false],
    ['6.3.9600', false],
    ['lixo', false],
    ['', false],
  ])('%s → %s', (release, esperado) => expect(windowsSuportaLoopbackPorProcesso(release)).toBe(esperado));

  it('extrai a build', () => {
    expect(buildDoWindows('10.0.22631')).toBe(22631);
    expect(buildDoWindows('abc')).toBeNull();
  });
});
