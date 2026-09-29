import { describe, expect, it } from 'vitest';
import { FakeRandom, FakeStorage } from '../testing/fakes.js';
import { INVITE_KEY, OWNER_KEY, SLUG_KEY, makeIdentity } from './owner-token.js';

describe('identidade do dono', () => {
  it('gera um token de 32 bytes em base64url na primeira vez', () => {
    const storage = new FakeStorage();
    const identity = makeIdentity(storage, new FakeRandom());
    const token = identity.ownerToken();

    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(storage.get(OWNER_KEY)).toBe(token);
  });

  it('reaproveita o token existente — nunca rotaciona sozinho', () => {
    const storage = new FakeStorage();
    const identity = makeIdentity(storage, new FakeRandom());
    expect(identity.ownerToken()).toBe(identity.ownerToken());
  });

  it('substitui token curto ou corrompido', () => {
    const storage = new FakeStorage();
    storage.set(OWNER_KEY, 'curto');
    const identity = makeIdentity(storage, new FakeRandom());
    expect(identity.ownerToken()).toHaveLength(43);
  });

  it('lembra e devolve o slug', () => {
    const storage = new FakeStorage();
    const identity = makeIdentity(storage, new FakeRandom());
    expect(identity.savedSlug()).toBeNull();
    identity.rememberSlug('joao');
    expect(identity.savedSlug()).toBe('joao');
    expect(storage.get(SLUG_KEY)).toBe('joao');
  });

  it('importa token colado, aparando espaço', () => {
    const storage = new FakeStorage();
    const identity = makeIdentity(storage, new FakeRandom());
    identity.importToken(`  ${'x'.repeat(43)}  `);
    expect(identity.exportToken()).toBe('x'.repeat(43));
  });

  it('forget apaga token e slug', () => {
    const storage = new FakeStorage();
    const identity = makeIdentity(storage, new FakeRandom());
    identity.ownerToken();
    identity.rememberSlug('joao');
    identity.forget();
    expect(storage.get(OWNER_KEY)).toBeNull();
    expect(storage.get(SLUG_KEY)).toBeNull();
  });
});

describe('convite antigo (ADR 0026)', () => {
  it('não existe mais, e forget limpa o que sobrou de antes', () => {
    const storage = new FakeStorage();
    storage.set(INVITE_KEY, 'c'.repeat(22));
    const identity = makeIdentity(storage, new FakeRandom());
    expect('convite' in identity).toBe(false);
    identity.forget();
    expect(storage.get(INVITE_KEY)).toBeNull();
  });
});
