import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCloudflareIceServers, parseCloudflareIceServers } from './cloudflare-turn.js';
import { makeChannelDeps, type Env, type WebCryptoLike } from './worker.js';

const stun = { urls: ['stun:stun.cloudflare.com:3478'] };
const turn = {
  urls: [
    'turn:turn.cloudflare.com:3478?transport=udp',
    'turn:turn.cloudflare.com:3478?transport=tcp',
    'turns:turn.cloudflare.com:5349?transport=tcp',
  ],
  username: 'fixture-user',
  credential: 'fixture-credential',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('contrato ICE da Cloudflare', () => {
  it('aceita a lista documentada e preserva STUN e TURN separados', () => {
    expect(parseCloudflareIceServers({ iceServers: [stun, turn] })).toEqual({
      servers: [stun, turn],
      hasRelay: true,
    });
  });

  it('aceita o objeto legado válido e uma lista mista de URLs', () => {
    expect(parseCloudflareIceServers({ iceServers: turn })).toEqual({
      servers: [turn],
      hasRelay: true,
    });
    expect(parseCloudflareIceServers({ iceServers: [{ ...turn, urls: ['stun:stun.example.com:3478', ...turn.urls] }] })?.hasRelay).toBe(true);
  });

  it('distingue STUN sozinho de relay disponível', () => {
    expect(parseCloudflareIceServers({ iceServers: [stun] })).toEqual({
      servers: [stun],
      hasRelay: false,
    });
  });

  it.each([
    ['lista vazia', { iceServers: [] }],
    ['credencial ausente', { iceServers: [{ urls: turn.urls, username: 'fixture-user' }] }],
    ['credencial em branco', { iceServers: [{ ...turn, credential: '  ' }] }],
    ['URL inválida', { iceServers: [{ ...turn, urls: ['https://example.com'] }] }],
    ['STUN com query TURN', { iceServers: [{ urls: ['stun:stun.example.com?transport=udp'] }] }],
    ['lista de URLs vazia', { iceServers: [{ ...turn, urls: [] }] }],
    ['lista grande demais', { iceServers: Array.from({ length: 9 }, () => stun) }],
    ['resposta parcial inválida', { iceServers: [stun, { ...turn, credential: undefined }] }],
  ])('rejeita %s por inteiro', (_case, body) => {
    expect(parseCloudflareIceServers(body)).toBeNull();
  });

  it('usa o endpoint e o corpo correspondentes à lista', async () => {
    let calledUrl = '';
    let calledInit: RequestInit | undefined;
    const request: typeof fetch = async (input, init) => {
      calledUrl = String(input);
      calledInit = init;
      return Response.json({ iceServers: [stun, turn] }, { status: 201 });
    };
    expect(await fetchCloudflareIceServers('fixture-key', 'fixture-token', 600, request)).toEqual({
      ok: true,
      servers: [stun, turn],
      hasRelay: true,
    });
    expect(calledUrl).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/fixture-key/credentials/generate-ice-servers');
    expect(calledInit?.method).toBe('POST');
    expect(calledInit?.body).toBe('{"ttl":600}');
    expect(calledInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('classifica JSON inválido e corpo fora do contrato', async () => {
    const invalidJson: typeof fetch = async () => new Response('{', { status: 201 });
    const invalidBody: typeof fetch = async () => Response.json({ iceServers: [] }, { status: 201 });
    expect(await fetchCloudflareIceServers('k', 't', 600, invalidJson)).toEqual({ ok: false, code: 'TURN_RESPONSE_INVALID' });
    expect(await fetchCloudflareIceServers('k', 't', 600, invalidBody)).toEqual({ ok: false, code: 'TURN_RESPONSE_INVALID' });
  });

  it.each([
    [401, 'TURN_AUTH_FAILED'],
    [403, 'TURN_AUTH_FAILED'],
    [429, 'TURN_RATE_LIMITED'],
    [500, 'TURN_UPSTREAM_FAILED'],
    [503, 'TURN_UPSTREAM_FAILED'],
  ] as const)('classifica HTTP %i', async (status, code) => {
    const request: typeof fetch = async () => new Response(null, { status });
    expect(await fetchCloudflareIceServers('k', 't', 600, request)).toEqual({ ok: false, code });
  });

  it('classifica timeout sem registrar detalhes da exceção', async () => {
    const request: typeof fetch = async () => { throw new DOMException('fixture-secret', 'TimeoutError'); };
    expect(await fetchCloudflareIceServers('k', 't', 600, request)).toEqual({ ok: false, code: 'TURN_TIMEOUT' });
  });

  it('entrega lista plana e registra somente código seguro para resposta inválida', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env: Env = { CHANNELS: null as never, TURN_KEY_ID: 'fixture-key', TURN_KEY_API_TOKEN: 'fixture-token' };
    const deps = makeChannelDeps(env, webcrypto as unknown as WebCryptoLike);

    vi.stubGlobal('fetch', async () => Response.json({ iceServers: [stun, turn] }, { status: 201 }));
    const servers = await deps.iceServersFor('peer');
    expect(servers.servers).toHaveLength(3);
    expect(servers.servers[1]).toEqual(stun);
    expect(servers.servers[2]).toEqual(turn);

    vi.stubGlobal('fetch', async () => Response.json({ iceServers: [stun, { ...turn, credential: undefined }] }, { status: 201 }));
    expect((await deps.iceServersFor('peer')).servers).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('TURN_RESPONSE_INVALID');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-token');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-credential');
  });

  it('informa ausência de relay quando a resposta tem só STUN', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async () => Response.json({ iceServers: [stun] }, { status: 201 }));
    const env: Env = { CHANNELS: null as never, TURN_KEY_ID: 'fixture-key', TURN_KEY_API_TOKEN: 'fixture-token' };
    const servers = await makeChannelDeps(env, webcrypto as unknown as WebCryptoLike).iceServersFor('peer');
    expect(servers.servers).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith('TURN_RELAY_ABSENT');
  });
});
