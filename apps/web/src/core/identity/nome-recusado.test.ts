import { afterEach, describe, expect, it } from 'vitest';
import { mascararCodigo } from './mascara.js';
import {
  espiarNomeRecusado,
  limparNomeRecusado,
  registrarNomeRecusado,
  sugerirNomes,
} from './nome-recusado.js';

afterEach(limparNomeRecusado);

describe('nome recusado', () => {
  it('lembra até ser limpo, e ler não apaga (StrictMode lê duas vezes)', () => {
    expect(espiarNomeRecusado()).toBeNull();
    registrarNomeRecusado({ slug: 'joao', motivo: 'em-uso' });
    expect(espiarNomeRecusado()).toEqual({ slug: 'joao', motivo: 'em-uso' });
    expect(espiarNomeRecusado()).toEqual({ slug: 'joao', motivo: 'em-uso' });
    limparNomeRecusado();
    expect(espiarNomeRecusado()).toBeNull();
  });
});

describe('sugerirNomes', () => {
  it('oferece duas variações no formato do slug', () => {
    expect(sugerirNomes('joao')).toEqual(['joao-2', 'joao-tv']);
  });

  it('corta o nome para caber nos 25 caracteres, sem hífen sobrando', () => {
    const longo = 'a'.repeat(24);
    for (const s of sugerirNomes(longo)) {
      expect(s.length).toBeLessThanOrEqual(25);
      expect(s).not.toMatch(/--/);
    }
  });

  it('nome vazio não sugere nada', () => {
    expect(sugerirNomes('')).toEqual([]);
  });
});

describe('mascararCodigo', () => {
  it('esconde tudo menos o último caractere', () => {
    const m = mascararCodigo('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
    expect(m).toBe('••••••••••••• G');
    expect(m).not.toContain('abc');
  });

  it('vazio fica vazio', () => {
    expect(mascararCodigo('')).toBe('');
  });
});
