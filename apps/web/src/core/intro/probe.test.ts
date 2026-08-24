import { describe, expect, it } from 'vitest';
import { aguentaCoreografia, decideModoAbertura, type Sondagem } from './probe.js';

const CAPAZ: Sondagem = {
  jaViu: false,
  movimentoReduzido: false,
  temWebGL: true,
  sondagemMs: 4,
};

describe('decideModoAbertura', () => {
  it('roda a coreografia numa máquina capaz, na primeira visita', () => {
    expect(decideModoAbertura(CAPAZ)).toBe('playing');
  });

  it('nunca cria o canvas na segunda visita', () => {
    expect(decideModoAbertura({ ...CAPAZ, jaViu: true })).toBe('bypass');
  });

  it('a segunda visita vence até quem pediu movimento reduzido', () => {
    // A ordem da §2 importa: `jaViu` é o passo 1. Quem já viu não paga nem o
    // crossfade de 300 ms do FADE.
    expect(decideModoAbertura({ ...CAPAZ, jaViu: true, movimentoReduzido: true })).toBe('bypass');
  });

  it('cai para FADE com prefers-reduced-motion', () => {
    expect(decideModoAbertura({ ...CAPAZ, movimentoReduzido: true })).toBe('fade');
  });

  it('cai para FADE sem contexto WebGL', () => {
    expect(decideModoAbertura({ ...CAPAZ, temWebGL: false })).toBe('fade');
  });

  it('desiste inteiro quando a própria sondagem estoura 150 ms', () => {
    expect(decideModoAbertura({ ...CAPAZ, sondagemMs: 150 })).toBe('playing');
    expect(decideModoAbertura({ ...CAPAZ, sondagemMs: 151 })).toBe('bypass');
  });
});

describe('aguentaCoreografia', () => {
  it('aceita até 32 ms de quadro e recusa acima disso', () => {
    expect(aguentaCoreografia(8)).toBe(true);
    expect(aguentaCoreografia(32)).toBe(true);
    expect(aguentaCoreografia(32.1)).toBe(false);
  });
});
