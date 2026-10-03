import { describe, expect, it } from 'vitest';
import { parseRoute } from './router.js';

describe('parseRoute', () => {
  it('as rotas fixas', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/transmitir')).toEqual({ name: 'broadcast' });
    expect(parseRoute('/recuperar')).toEqual({ name: 'recover' });
  });

  it('um canal', () => {
    expect(parseRoute('/soumbra')).toEqual({ name: 'viewer', slug: 'soumbra', canais: ['soumbra'] });
  });

  it('multivisão: /a+b abre os dois, o primeiro como principal (ADR 0032)', () => {
    expect(parseRoute('/soumbra+ana/')).toEqual({ name: 'viewer', slug: 'soumbra', canais: ['soumbra', 'ana'] });
  });

  it('caminho que não é canal', () => {
    expect(parseRoute('/jv')).toEqual({ name: 'not-found' });
    expect(parseRoute('/ana+')).toEqual({ name: 'not-found' });
    expect(parseRoute('/a/b')).toEqual({ name: 'not-found' });
  });
});
