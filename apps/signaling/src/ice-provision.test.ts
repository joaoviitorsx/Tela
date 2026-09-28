import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCloudflareIceServers, type CloudflareTurnResult } from './cloudflare-turn.js';
import { makeCloudflareProvider } from './ice-provision.js';
import { parseIceSettings } from './ice-settings.js';
import { makeChannelDeps, type Env, type WebCryptoLike } from './worker.js';

const turn = { urls: ['turn:relay.example.com:3478'], username: 'user', credential: 'credential' };
const settingsResult = parseIceSettings({ TURN_KEY_ID: 'id', TURN_KEY_API_TOKEN: 'token' });
if (!('settings' in settingsResult)) throw new Error('fixture inválido');
const settings = settingsResult.settings;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('provedor ICE resiliente', () => {
  it('cancela e termina mesmo se o fetch ignorar o signal', async () => {
    let signal: AbortSignal | undefined;
    const request: typeof fetch = async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    };
    const started = Date.now();
    expect(await fetchCloudflareIceServers('id', 'token', 600, request, 25)).toEqual({ ok: false, code: 'TURN_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(200);
    expect(signal?.aborted).toBe(true);
  });

  it('repete somente falha transitória e limita o segundo prazo ao orçamento total', async () => {
    let calls = 0;
    const timeouts: number[] = [];
    const fetchTurn: typeof fetchCloudflareIceServers = async (_id, _token, _ttl, _request, timeout) => {
      calls += 1;
      timeouts.push(timeout ?? 2500);
      return calls === 1
        ? { ok: false, code: 'TURN_UPSTREAM_FAILED' }
        : { ok: true, servers: [turn], hasRelay: true };
    };
    let clock = 1000;
    const provider = makeCloudflareProvider(settings, fetchTurn, () => clock, async (ms) => { clock += ms; });
    const result = await provider();
    expect(result).toMatchObject({ relayStatus: 'available', expiresAt: clock + 600_000 });
    expect(calls).toBe(2);
    expect(timeouts).toEqual([2500, 2500]);
  });

  it('não repete 401 e abre o circuito sem revelar credenciais', async () => {
    let calls = 0;
    let clock = 0;
    const fetchTurn: typeof fetchCloudflareIceServers = async () => {
      calls += 1;
      return { ok: false, code: 'TURN_AUTH_FAILED' };
    };
    const provider = makeCloudflareProvider(settings, fetchTurn, () => clock);
    expect(await provider()).toMatchObject({ relayStatus: 'unavailable', failureCode: 'TURN_AUTH_FAILED' });
    expect(await provider()).toMatchObject({ relayStatus: 'unavailable', failureCode: 'TURN_AUTH_FAILED' });
    expect(calls).toBe(1);
    clock = 30_001;
    await provider();
    expect(calls).toBe(2);
  });

  it('reduz o prazo da repetição após timeout e não repete 429', async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const fetchTurn: typeof fetchCloudflareIceServers = async (_id, _token, _ttl, _request, timeout) => {
      timeouts.push(timeout ?? 2500);
      if (timeouts.length === 1) clock += 2500;
      return { ok: false, code: 'TURN_TIMEOUT' };
    };
    await makeCloudflareProvider(settings, fetchTurn, () => clock, async (ms) => { clock += ms; })();
    expect(timeouts).toEqual([2500, 2400]);

    let calls = 0;
    const rateLimited: typeof fetchCloudflareIceServers = async () => {
      calls += 1;
      return { ok: false, code: 'TURN_RATE_LIMITED' };
    };
    expect((await makeCloudflareProvider(settings, rateLimited)()).failureCode).toBe('TURN_RATE_LIMITED');
    expect(calls).toBe(1);
  });

  it('abre o circuito depois de falhas repetidas e volta a tentar após a janela', async () => {
    let calls = 0;
    let clock = 0;
    const fetchTurn: typeof fetchCloudflareIceServers = async () => {
      calls += 1;
      return { ok: false, code: 'TURN_UPSTREAM_FAILED' };
    };
    const provider = makeCloudflareProvider(settings, fetchTurn, () => clock, async (ms) => { clock += ms; });
    await provider();
    await provider();
    await provider();
    const before = calls;
    expect((await provider()).relayStatus).toBe('unavailable');
    expect(calls).toBe(before);
    clock += 30_001;
    await provider();
    expect(calls).toBeGreaterThan(before);
  });

  it('resposta só STUN continua sem relay e sem causa pública sensível', async () => {
    const fetchTurn: typeof fetchCloudflareIceServers = async (): Promise<CloudflareTurnResult> => ({
      ok: true, servers: [{ urls: ['stun:stun.example.com:3478'] }], hasRelay: false,
    });
    const result = await makeCloudflareProvider(settings, fetchTurn)();
    expect(result.relayStatus).toBe('unavailable');
    expect(result.failureCode).toBe('TURN_RELAY_ABSENT');
  });

  it('Worker usa coturn como fallback e mantém a falha Cloudflare apenas interna', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));
    const env: Env = {
      CHANNELS: null as never,
      TURN_KEY_ID: 'id', TURN_KEY_API_TOKEN: 'fixture-token',
      TURN_URLS: 'turn:relay.example.com:3478,turns:relay.example.com:443?transport=tcp',
      TURN_SECRET: 'fixture-secret',
    };
    const result = await makeChannelDeps(env, webcrypto as unknown as WebCryptoLike).iceServersFor('peer');
    expect(result.relayStatus).toBe('available');
    expect(result.failureCode).toBe('TURN_AUTH_FAILED');
    expect(result.servers[1]?.urls).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith('TURN_AUTH_FAILED');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-token');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-secret');
  });
});
