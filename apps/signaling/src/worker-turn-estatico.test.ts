import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Env, makeChannelDeps, type WebCryptoLike } from './worker.js';

const base = {
  CHANNELS: {} as Env['CHANNELS'],
  TURN_URLS: 'turn:relay1.expressturn.com:3478?transport=udp,turn:relay1.expressturn.com:443?transport=tcp',
  TURN_USERNAME: 'usuario',
  TURN_PASSWORD: 'senha',
} satisfies Partial<Env>;

const deps = (env: Partial<Env>) => makeChannelDeps(env as Env, webcrypto as unknown as WebCryptoLike, () => undefined);

describe('TURN com senha fixa (plano grátis sem cartão)', () => {
  it('com o aceite explícito, entrega o relay com a senha fixa e sem validade', async () => {
    const r = await deps({ ...base, TURN_ESTATICO: 'aceito' }).iceServersFor('v_1');
    expect(r.relayStatus).toBe('available');
    expect(r.expiresAt).toBeUndefined();
    const turn = r.servers.find((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith('turn:')));
    expect(turn).toMatchObject({ username: 'usuario', credential: 'senha' });
  });

  it('sem o aceite, senha fixa continua recusada', async () => {
    const r = await deps(base).iceServersFor('v_1');
    expect(r.relayStatus).toBe('not-configured');
    expect(r.servers.some((s) => 'username' in s)).toBe(false);
  });

  it('o segredo compartilhado (coturn) vence a senha fixa', async () => {
    const { TURN_USERNAME: _u, TURN_PASSWORD: _p, ...semSenha } = base;
    const r = await deps({ ...semSenha, TURN_ESTATICO: 'aceito', TURN_SECRET: 'segredo' }).iceServersFor('v_1');
    expect(r.relayStatus).toBe('available');
    expect(r.expiresAt).toBeTypeOf('number');
  });
});
