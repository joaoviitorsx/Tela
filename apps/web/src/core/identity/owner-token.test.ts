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

describe('convite do link (TELA-018)', () => {
  /** Um byte diferente por chamada: renovar tem de produzir outro segredo. */
  class SequenciaRandom {
    private n = 0;
    bytes(length: number): Uint8Array {
      this.n += 1;
      return new Uint8Array(length).fill(this.n);
    }
  }

  it('128 bits em base64url, guardado e estável entre transmissões', () => {
    const storage = new FakeStorage();
    const identity = makeIdentity(storage, new SequenciaRandom());
    const convite = identity.convite();
    expect(convite).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(identity.convite()).toBe(convite);
    expect(storage.get(INVITE_KEY)).toBe(convite);
  });

  it('independente do token do dono', () => {
    const identity = makeIdentity(new FakeStorage(), new SequenciaRandom());
    expect(identity.ownerToken()).not.toContain(identity.convite());
  });

  it('renovar troca e guarda; o antigo não volta', () => {
    const storage = new FakeStorage();
    const identity = makeIdentity(storage, new SequenciaRandom());
    const antigo = identity.convite();
    const novo = identity.renovarConvite();
    expect(novo).not.toBe(antigo);
    expect(identity.convite()).toBe(novo);
  });

  it('convite corrompido no storage é regenerado', () => {
    const storage = new FakeStorage();
    storage.set(INVITE_KEY, 'curto');
    expect(makeIdentity(storage, new SequenciaRandom()).convite()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
