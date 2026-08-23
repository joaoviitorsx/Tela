import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, map, ok, unwrapOr } from './result.js';

describe('Result', () => {
  it('ok carrega valor', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(r.ok && r.value).toBe(42);
  });

  it('err carrega erro', () => {
    const r = err('SLUG_TAKEN' as const);
    expect(isErr(r)).toBe(true);
    expect(!r.ok && r.error).toBe('SLUG_TAKEN');
  });

  it('map só aplica no caminho feliz', () => {
    expect(map(ok(2), (n) => n * 2)).toEqual({ ok: true, value: 4 });
    expect(map(err('X'), (n: number) => n * 2)).toEqual({ ok: false, error: 'X' });
  });

  it('unwrapOr devolve o fallback no erro', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err('X') as never, 9)).toBe(9);
  });
});
