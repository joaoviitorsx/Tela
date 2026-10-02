import { APELIDO_MAX, ApelidoSchema, apelidoUnico, normalizarApelido } from '@tela/shared';
import { describe, expect, it } from 'vitest';

describe('apelido (S-20)', () => {
  it('NFC: as duas formas de "é" viram a mesma', () => {
    expect(normalizarApelido('é')).toBe('é');
  });

  it('remove controle, bidi, zero-width e separador de linha; colapsa espaços', () => {
    expect(normalizarApelido('a‮b​c d\ne\u0000f')).toBe('abc d ef'); // quebra de linha vira espaço; o resto some
    expect(normalizarApelido('  um   dois ')).toBe('um dois');
  });

  it('ZWJ só entre caracteres visíveis: emoji composto fica, ZWJ solto some', () => {
    expect(normalizarApelido('👨‍👩')).toBe('👨‍👩');
    expect(normalizarApelido('‍a‍‍‍b‍')).toBe('a‍b');
  });

  it('o teto é em grafemas, não em unidades UTF-16', () => {
    expect(ApelidoSchema.safeParse('😀'.repeat(APELIDO_MAX)).success).toBe(true);
    expect(ApelidoSchema.safeParse('😀'.repeat(APELIDO_MAX + 1)).success).toBe(false);
    expect(ApelidoSchema.safeParse('x'.repeat(APELIDO_MAX + 1)).success).toBe(false);
    expect(ApelidoSchema.safeParse(`a${'́'.repeat(100)}`).success).toBe(false);
  });

  it('vazio depois de limpar é inválido; o valor devolvido já vem normalizado', () => {
    expect(ApelidoSchema.safeParse('​ ‮').success).toBe(false);
    const r = ApelidoSchema.safeParse(' José ');
    expect(r.success && r.data).toBe('José');
  });

  it('apelidoUnico: ignora caixa e compatibilidade, numera e respeita o teto', () => {
    expect(apelidoUnico('Ana', [])).toBe('Ana');
    expect(apelidoUnico('Ana', ['ANA'])).toBe('Ana (2)');
    expect(apelidoUnico('Ana', ['ana', 'Ana (2)'])).toBe('Ana (3)');
    expect(apelidoUnico('ＭＡＲＩＡ', ['maria'])).toBe('ＭＡＲＩＡ (2)');
    const longo = apelidoUnico('x'.repeat(APELIDO_MAX), ['x'.repeat(APELIDO_MAX)]);
    expect([...longo].length).toBeLessThanOrEqual(APELIDO_MAX);
    expect(longo.endsWith(' (2)')).toBe(true);
  });
});
