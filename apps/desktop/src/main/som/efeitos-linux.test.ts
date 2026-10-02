import { describe, expect, it } from 'vitest';
import { efeitosLinux } from './efeitos-linux.js';

describe('encerrarOrfaos (S-12)', () => {
  const nosso = (n: string) => ['/usr/bin/pw-loopback', '-n', n].join('\0');

  it('só mata o pid que o app registrou E que o /proc ainda confirma', () => {
    const mortos: number[] = [];
    const registro = JSON.stringify([
      { pid: 111, nome: 'tela_jogo_lb' }, // confere: morre
      { pid: 222, nome: 'tela_jogo_mic_lb' }, // pid reciclado por outro programa: não
      { pid: 333, nome: 'tela_sistema_mic_lb' }, // já não existe: não
    ]);
    let gravado = '';
    const e = efeitosLinux(
      () => new Set(),
      { ler: () => registro, gravar: (t) => (gravado = t) },
      (pid) => (pid === 111 ? nosso('tela_jogo_lb') : pid === 222 ? ['/usr/bin/firefox'].join('\0') : null),
      (pid) => mortos.push(pid),
    );
    expect(e.encerrarOrfaos()).toBe(1);
    expect(mortos).toEqual([111]);
    // O registro é reescrito sem os órfãos (nada de repetir o sinal na próxima).
    expect(JSON.parse(gravado)).toEqual([]);
  });

  it('sem registro, não mata ninguém — um pid declarado no PipeWire nunca é considerado', () => {
    const mortos: number[] = [];
    const e = efeitosLinux(() => new Set(), { ler: () => null, gravar: () => undefined }, () => nosso('tela_jogo_lb'), (p) => mortos.push(p));
    expect(e.encerrarOrfaos()).toBe(0);
    expect(mortos).toEqual([]);
  });
});
