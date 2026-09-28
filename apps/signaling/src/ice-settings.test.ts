import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { parseConfig } from './config.js';
import { describeIceSettings, parseIceSettings } from './ice-settings.js';
import { makeIceProvider } from './ice.js';
import { makeChannelDeps, type Env, type WebCryptoLike } from './worker.js';

const urls = 'turn:relay.example.com:3478?transport=udp,turn:relay.example.com:3478?transport=tcp,turns:relay.example.com:443?transport=tcp';

describe('configuração ICE', () => {
  it('aceita URLs múltiplas e migração da URL singular', () => {
    const parsed = parseIceSettings({ TURN_URLS: urls, TURN_SECRET: 'fixture-secret' });
    expect('settings' in parsed).toBe(true);
    if (!('settings' in parsed)) return;
    expect(parsed.settings.turnUrls).toHaveLength(3);
    expect(parseIceSettings({ TURN_URL: 'turn:relay.example.com:3478', TURN_SECRET: 'fixture-secret' })).toMatchObject({
      settings: { turnUrls: ['turn:relay.example.com:3478'] },
    });
    expect(JSON.stringify(describeIceSettings(parsed.settings))).not.toContain('fixture-secret');
    expect(describeIceSettings(parsed.settings)).toMatchObject({ coturnConfigured: true, turnUrls: 3 });
  });

  it.each([
    [{ TURN_URLS: urls }, 'COTURN_CONFIG_INCOMPLETE'],
    [{ TURN_SECRET: 'secret' }, 'COTURN_CONFIG_INCOMPLETE'],
    [{ TURN_KEY_ID: 'id' }, 'CLOUDFLARE_CONFIG_INCOMPLETE'],
    [{ TURN_KEY_API_TOKEN: 'token' }, 'CLOUDFLARE_CONFIG_INCOMPLETE'],
    [{ TURN_URL: 'turn:a.example.com', TURN_URLS: urls, TURN_SECRET: 'secret' }, 'TURN_URLS_AMBIGUOUS'],
    [{ TURN_URLS: 'https://relay.example.com', TURN_SECRET: 'secret' }, 'TURN_URLS_INVALID'],
    [{ TURN_URLS: 'turn:relay.example.com:3478,', TURN_SECRET: 'secret' }, 'TURN_URLS_INVALID'],
    [{ STUN_URLS: 'turn:relay.example.com' }, 'STUN_URLS_INVALID'],
    [{ ICE_PROVIDER: 'cloudflare' }, 'CLOUDFLARE_NOT_CONFIGURED'],
    [{ TURN_TTL_SECONDS: '0' }, 'TURN_TTL_SECONDS_INVALID'],
    [{ TURN_FETCH_TIMEOUT_MS: '9000' }, 'TURN_FETCH_TIMEOUT_MS_INVALID'],
    [{ TURN_USERNAME: 'user' }, 'STATIC_TURN_CONFIG_INCOMPLETE'],
  ] as const)('rejeita configuração inválida sem ecoar valores', (input, code) => {
    const parsed = parseIceSettings(input);
    expect('problems' in parsed && parsed.problems).toContain(code);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('Node rejeita credencial estática em produção mesmo com TURN_SECRET', () => {
    const parsed = parseConfig({
      NODE_ENV: 'production', TURN_URLS: urls, TURN_SECRET: 'secret',
      TURN_USERNAME: 'user', TURN_PASSWORD: 'password',
    });
    expect('problems' in parsed).toBe(true);
    if ('problems' in parsed) expect(parsed.problems.join(' ')).toContain('credencial estática');
  });

  it('Node exige ALLOWED_ORIGINS em produção, e aceita quando há lista (TELA-019)', () => {
    const sem = parseConfig({ NODE_ENV: 'production' });
    expect('problems' in sem && sem.problems.join(' ')).toContain('ALLOWED_ORIGINS');
    const com = parseConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://tela.gg' });
    expect('config' in com && com.config.allowedOrigins).toEqual(['https://tela.gg']);
    // Desenvolvimento continua sem regra.
    expect('config' in parseConfig({})).toBe(true);
  });

  it('Node não aceita Cloudflare configurada sem adaptador assíncrono', () => {
    const parsed = parseConfig({ TURN_KEY_ID: 'id', TURN_KEY_API_TOKEN: 'token' });
    expect('problems' in parsed && parsed.problems).toContain('CLOUDFLARE_UNSUPPORTED_ON_NODE');
  });

  it('Worker rejeita secrets incompletas e limite inválido sem mostrar valores', () => {
    const crypto = webcrypto as unknown as WebCryptoLike;
    const partial: Env = { CHANNELS: null as never, TURN_KEY_ID: 'fixture-secret' };
    expect(() => makeChannelDeps(partial, crypto)).toThrow('CLOUDFLARE_CONFIG_INCOMPLETE');
    expect(() => makeChannelDeps(partial, crypto)).not.toThrow('fixture-secret');
    expect(() => makeChannelDeps({ CHANNELS: null as never, MAX_PEERS: '999' }, crypto)).toThrow('MAX_PEERS_INVALID');
  });

  it('coturn emite uma credencial efêmera para todas as URLs', () => {
    const parsed = parseConfig({ TURN_URLS: urls, TURN_SECRET: 'fixture-secret' });
    if (!('config' in parsed)) throw new Error('fixture inválido');
    const result = makeIceProvider(parsed.config)('peer-1');
    expect(result.relayStatus).toBe('available');
    expect(result.servers[1]?.urls).toHaveLength(3);
    expect(result.servers[1]?.username).toContain(':peer-1');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });
});
