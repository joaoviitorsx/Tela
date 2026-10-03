import { describe, expect, it, vi } from 'vitest';
import { mensagemAoVivo } from '../core/domain/webhook-discord.js';
import { makeDiscordWebhook } from './discord-webhook.js';

const W = { id: '123456789012345678', token: 'abcDEF123_-abcDEF123_-abcDEF123_-xyz' };
const CORPO = mensagemAoVivo('soumbra', 'https://tela.gg/soumbra');

describe('makeDiscordWebhook', () => {
  it('publica com wait=true e devolve o id da mensagem', async () => {
    const fazer = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(JSON.stringify({ id: '999' }), { status: 200 }));
    const r = await makeDiscordWebhook(fazer).publicar(W, CORPO);
    expect(r).toEqual({ ok: true, value: { mensagemId: '999' } });
    expect(fazer.mock.calls[0]?.[0]).toBe(`https://discord.com/api/v10/webhooks/${W.id}/${W.token}?wait=true`);
  });

  it('404 é RECUSADO (webhook apagado); 429 e rede são FALHOU', async () => {
    const com = (status: number) => makeDiscordWebhook(async () => new Response('{}', { status }));
    expect(await com(404).publicar(W, CORPO)).toEqual({ ok: false, error: 'RECUSADO' });
    expect(await com(429).publicar(W, CORPO)).toEqual({ ok: false, error: 'FALHOU' });
    const caiu = makeDiscordWebhook(async () => {
      throw new TypeError('offline');
    });
    expect(await caiu.editar(W, '1', CORPO)).toEqual({ ok: false, error: 'FALHOU' });
  });

  it('editar ao sair vai com keepalive', async () => {
    const fazer = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 200 }));
    await makeDiscordWebhook(fazer).editar(W, '42', CORPO, { aoSair: true });
    const [url, init] = fazer.mock.calls[0] ?? [];
    expect(url).toBe(`https://discord.com/api/v10/webhooks/${W.id}/${W.token}/messages/42`);
    expect(init?.method).toBe('PATCH');
    expect(init?.keepalive).toBe(true);
  });
});
