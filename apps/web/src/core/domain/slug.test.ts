import { describe, expect, it } from 'vitest';
import { parseSlug, suggestAlternatives } from './slug.js';
import { TEST_POLICY } from '../testing/fakes.js';

describe('parseSlug', () => {
  it.each(['joao', 'joao-plays', 'a1b', 'x'.repeat(25)])('aceita %s', (raw) => {
    expect(parseSlug(raw, TEST_POLICY).ok).toBe(true);
  });

  it.each([
    ['ab', 'curto demais'],
    ['x'.repeat(26), 'longo demais'],
    ['-joao', 'começa com hífen'],
    ['joao-', 'termina com hífen'],
    ['JV_plays', 'maiúscula e underscore'],
    ['joao plays', 'espaço'],
    ['joao.gg', 'ponto'],
  ])('rejeita %s (%s)', (raw) => {
    const r = parseSlug(raw, TEST_POLICY);
    expect(r).toEqual({ ok: false, error: 'SLUG_INVALID' });
  });

  it('normaliza caixa e espaço em volta', () => {
    const r = parseSlug('  JoAo  ', TEST_POLICY);
    expect(r).toEqual({ ok: true, value: 'joao' });
  });

  it('rejeita rota reservada', () => {
    expect(parseSlug('api', TEST_POLICY)).toEqual({ ok: false, error: 'SLUG_RESERVED' });
  });

  it('rejeita termo ofensivo', () => {
    expect(parseSlug('puta', TEST_POLICY)).toEqual({ ok: false, error: 'SLUG_RESERVED' });
  });
});

describe('suggestAlternatives', () => {
  it('gera sugestões válidas e determinísticas', () => {
    expect(suggestAlternatives('joao', TEST_POLICY)).toEqual(['joao2', 'joaobr', 'joao-plays']);
    expect(suggestAlternatives('joao', TEST_POLICY)).toEqual(['joao2', 'joaobr', 'joao-plays']);
  });

  it('pula as que já estão ocupadas', () => {
    const out = suggestAlternatives('joao', TEST_POLICY, new Set(['joao2', 'joaobr']));
    expect(out).toEqual(['joao-plays', 'joao-live', 'joaogg']);
  });

  it('não sugere nada quando a base torna todo sufixo inválido', () => {
    expect(suggestAlternatives('x'.repeat(25), TEST_POLICY)).toEqual([]);
  });
});
