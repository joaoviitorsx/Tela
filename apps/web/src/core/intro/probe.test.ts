import { describe, expect, it } from 'vitest';
import { aguentaCoreografia, decideModoAbertura, type Sondagem } from './probe.js';

const CAPAZ: Sondagem = {
  movimentoReduzido: false,
  temWebGL: true,
  sondagemMs: 4,
};

describe('decideModoAbertura', () => {
  it('roda a coreografia numa máquina capaz', () => {
    expect(decideModoAbertura(CAPAZ)).toBe('playing');
  });

  it('roda de novo a cada visita — não existe mais o passo "já viu" (ADR 0013)', () => {
    // A sondagem não recebe histórico nenhum. Se um dia alguém quiser o bypass
    // de volta, o lugar é aqui, e este teste é o que vai falhar primeiro.
    expect(decideModoAbertura(CAPAZ)).toBe('playing');
    expect(decideModoAbertura(CAPAZ)).toBe('playing');
    expect(Object.keys(CAPAZ)).not.toContain('jaViu');
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
