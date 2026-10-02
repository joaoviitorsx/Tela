import { describe, expect, it } from 'vitest';
import { cmdlineConfere, lerRegistro, serializarRegistro } from './filhos-registrados.js';

describe('registro dos pw-loopback do Tela (S-12)', () => {
  it('vai e volta; lixo e entradas inválidas somem', () => {
    const f = [{ pid: 4242, nome: 'tela_jogo_lb' }];
    expect(lerRegistro(serializarRegistro(f))).toEqual(f);
    expect(lerRegistro(null)).toEqual([]);
    expect(lerRegistro('{')).toEqual([]);
    expect(lerRegistro('{"pid":5}')).toEqual([]);
    const ruins = [
      { pid: 1, nome: 'tela_jogo_lb' },
      { pid: -5, nome: 'tela_jogo_lb' },
      { pid: 1.5, nome: 'tela_jogo_lb' },
      { pid: 4242, nome: 'firefox' },
      { pid: 4242, nome: 'tela_jogo_lb; rm' },
      { pid: '4242', nome: 'tela_jogo_lb' },
      null,
      7,
    ];
    expect(lerRegistro(JSON.stringify(ruins))).toEqual([]);
  });

  it('só confere se o processo É um pw-loopback com o nosso -n (pid reciclado não passa)', () => {
    const f = { pid: 4242, nome: 'tela_jogo_lb' };
    const nosso = ['/usr/bin/pw-loopback', '-n', 'tela_jogo_lb', '-i', 'media.class=Audio/Sink'].join('\0');
    expect(cmdlineConfere(f, nosso)).toBe(true);
    expect(cmdlineConfere(f, ['pw-loopback', '-n', 'tela_jogo_lb'].join('\0'))).toBe(true);
    // Outro programa herdou o pid.
    expect(cmdlineConfere(f, ['/usr/bin/firefox', '-n', 'tela_jogo_lb'].join('\0'))).toBe(false);
    // O mesmo binário, mas de outro `-n`: não é o nosso.
    expect(cmdlineConfere(f, ['/usr/bin/pw-loopback', '-n', 'outro'].join('\0'))).toBe(false);
    expect(cmdlineConfere(f, '')).toBe(false);
  });
});
