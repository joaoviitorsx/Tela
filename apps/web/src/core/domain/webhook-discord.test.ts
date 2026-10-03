import { describe, expect, it } from 'vitest';
import { duracaoLegivel, lerWebhook, mensagemAoVivo, urlDoWebhook, webhookMascarado } from './webhook-discord.js';

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-xyz';

describe('webhook do Discord', () => {
  it('aceita as formas que o Discord entrega', () => {
    for (const url of [
      `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`,
      `https://discordapp.com/api/webhooks/123456789012345678/${TOKEN}`,
      `https://canary.discord.com/api/v10/webhooks/123456789012345678/${TOKEN}/`,
      `  https://ptb.discord.com/api/webhooks/123456789012345678/${TOKEN}?wait=true `,
    ]) {
      const r = lerWebhook(url);
      expect(r.ok && r.value).toEqual({ id: '123456789012345678', token: TOKEN });
    }
  });

  it('recusa o que não é webhook do Discord', () => {
    for (const url of [
      '',
      `http://discord.com/api/webhooks/123456789012345678/${TOKEN}`,
      `https://evil.com/api/webhooks/123456789012345678/${TOKEN}`,
      `https://discord.com.evil.com/api/webhooks/123456789012345678/${TOKEN}`,
      'https://discord.com/api/webhooks/123/curto',
      `https://discord.com/channels/123456789012345678/${TOKEN}`,
    ]) {
      expect(lerWebhook(url).ok).toBe(false);
    }
  });

  it('URL canônica e máscara sem o token', () => {
    const w = { id: '123456789012345678', token: TOKEN };
    expect(urlDoWebhook(w)).toBe(`https://discord.com/api/v10/webhooks/123456789012345678/${TOKEN}`);
    expect(webhookMascarado(w)).not.toContain(TOKEN.slice(4, 12));
  });

  it('a mensagem de AO VIVO leva o link e não marca ninguém', () => {
    const m = mensagemAoVivo('soumbra', 'https://tela.gg/soumbra');
    expect(m.embeds[0]?.title).toBe('soumbra está AO VIVO');
    expect(m.embeds[0]?.url).toBe('https://tela.gg/soumbra');
    expect(m.allowed_mentions.parse).toEqual([]);
    expect(m.avatar_url).toBe('https://tela.gg/tela-app-icon.png');
  });

  it('duração legível', () => {
    expect(duracaoLegivel(30_000)).toBe('menos de 1 min');
    expect(duracaoLegivel(8 * 60_000)).toBe('8 min');
    expect(duracaoLegivel(60 * 60_000)).toBe('1h');
    expect(duracaoLegivel(72 * 60_000)).toBe('1h 12min');
  });
});
