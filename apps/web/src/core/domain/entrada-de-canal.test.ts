import { describe, expect, it } from 'vitest';
import { canalDaEntrada } from './entrada-de-canal.js';

const slugDe = (entrada: string): string | null => {
  const r = canalDaEntrada(entrada);
  return r.ok ? r.value : null;
};

describe('canalDaEntrada', () => {
  it('só o nome do canal', () => {
    expect(slugDe('joao')).toBe('joao');
    expect(slugDe('  Joao  ')).toBe('joao');
  });
  it('o link completo, de qualquer origem, com ou sem barra final', () => {
    expect(slugDe('https://tela.gg/joao')).toBe('joao');
    expect(slugDe('https://tela.gg/joao/')).toBe('joao');
    expect(slugDe('http://localhost:5173/joao')).toBe('joao');
    expect(slugDe('https://tela-3ph.pages.dev/joao')).toBe('joao');
  });
  it('o link sem o esquema', () => {
    expect(slugDe('tela.gg/joao')).toBe('joao');
    expect(slugDe('localhost:5173/joao')).toBe('joao');
  });
  it('o link do app', () => {
    expect(slugDe('tela://assistir/joao')).toBe('joao');
    expect(slugDe('TELA://assistir/joao/')).toBe('joao');
  });
  it('consulta e fragmento (inclusive o #k= antigo) são ignorados', () => {
    expect(slugDe('https://tela.gg/joao#k=abc')).toBe('joao');
    expect(slugDe('https://tela.gg/joao?x=1')).toBe('joao');
    expect(slugDe('tela://assistir/joao?x=1#y')).toBe('joao');
  });
  it('recusa caminho com mais de um segmento ou sem nenhum', () => {
    expect(slugDe('https://tela.gg/')).toBeNull();
    expect(slugDe('https://tela.gg')).toBeNull();
    expect(slugDe('https://tela.gg/a/joao')).toBeNull();
    expect(slugDe('tela.gg/joao/extra')).toBeNull();
  });
  it('recusa outros esquemas e o link do app com outro destino', () => {
    expect(slugDe('javascript:alert(1)')).toBeNull();
    expect(slugDe('ftp://tela.gg/joao')).toBeNull();
    expect(slugDe('tela://transmitir/joao')).toBeNull();
    expect(slugDe('mailto:joao')).toBeNull();
  });
  it('recusa nome fora da regra, rota do site e entrada vazia', () => {
    expect(slugDe('jv')).toBeNull();
    expect(slugDe('jo ao')).toBeNull();
    expect(slugDe('-joao')).toBeNull();
    expect(slugDe('transmitir')).toBeNull();
    expect(slugDe('https://tela.gg/recuperar')).toBeNull();
    expect(slugDe('')).toBeNull();
    expect(slugDe('   ')).toBeNull();
    expect(slugDe('a'.repeat(600))).toBeNull();
    expect(slugDe('algo/qualquer')).toBeNull();
  });
  it('o erro é SLUG_INVALID, um retorno normal e não uma exceção', () => {
    const r = canalDaEntrada('???');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('SLUG_INVALID');
  });
});
