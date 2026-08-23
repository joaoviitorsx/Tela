import { describe, expect, it } from 'vitest';
import { ExpiringMap } from './expiring-map.js';

function clock(start = 0) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

describe('ExpiringMap', () => {
  it('devolve o valor antes do TTL', () => {
    const c = clock();
    const m = new ExpiringMap<number>(c.now);
    m.set('a', 1, 30);
    c.advance(29_000);
    expect(m.get('a')).toBe(1);
  });

  it('expira exatamente no limite', () => {
    const c = clock();
    const m = new ExpiringMap<number>(c.now);
    m.set('a', 1, 30);
    c.advance(30_000);
    expect(m.get('a')).toBeNull();
  });

  it('touch renova o que está vivo', () => {
    const c = clock();
    const m = new ExpiringMap<number>(c.now);
    m.set('a', 1, 30);
    c.advance(20_000);
    expect(m.touch('a', 30)).toBe(true);
    c.advance(20_000);
    expect(m.get('a')).toBe(1);
  });

  it('touch NÃO ressuscita o que já morreu — equivale a EXPIRE XX', () => {
    const c = clock();
    const m = new ExpiringMap<number>(c.now);
    m.set('a', 1, 30);
    c.advance(31_000);
    expect(m.touch('a', 30)).toBe(false);
    expect(m.get('a')).toBeNull();
  });

  it('size ignora expirados', () => {
    const c = clock();
    const m = new ExpiringMap<number>(c.now);
    m.set('a', 1, 10);
    m.set('b', 2, 60);
    c.advance(11_000);
    expect(m.size).toBe(1);
  });
});
