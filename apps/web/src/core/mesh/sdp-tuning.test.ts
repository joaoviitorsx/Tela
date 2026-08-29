import { describe, expect, it } from 'vitest';
import { afinarSdp } from './sdp-tuning.js';

/**
 * SDP mínimo com as duas seções que importam: áudio, que precisa sair
 * intocado, e vídeo com as variantes de H.264 que o Chromium de fato oferece.
 */
const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 98 100',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:98 H264/90000',
  'a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f',
  'a=rtpmap:100 VP8/90000',
  '',
].join('\r\n');

describe('afinarSdp — nível do H.264', () => {
  it('sobe 3.1 para 4.2 em toda variante de H.264', () => {
    const saida = afinarSdp(SDP);
    expect(saida).toContain('profile-level-id=42e02a');
    expect(saida).toContain('profile-level-id=640c2a');
    expect(saida).not.toContain('01f');
  });

  it('PRESERVA profile_idc e profile_iop — é por eles que a negociação casa', () => {
    const saida = afinarSdp(SDP);
    // Só os dois últimos dígitos mudam. Mexer nos quatro primeiros faria os
    // dois lados deixarem de casar o codec, e a chamada cairia para VP8.
    expect(saida).toContain('profile-level-id=42e0');
    expect(saida).toContain('profile-level-id=640c');
  });

  it('não REBAIXA um nível que já está acima do mínimo', () => {
    const alto = SDP.replace('42e01f', '42e034');
    expect(afinarSdp(alto)).toContain('profile-level-id=42e034');
  });

  it('é idempotente — rodar duas vezes dá o mesmo SDP', () => {
    const uma = afinarSdp(SDP, { startBitrateBps: 4_000_000 });
    expect(afinarSdp(uma, { startBitrateBps: 4_000_000 })).toBe(uma);
  });
});

describe('afinarSdp — bitrate inicial', () => {
  it('injeta x-google-start-bitrate em kbps nas linhas de H.264', () => {
    const saida = afinarSdp(SDP, { startBitrateBps: 4_000_000 });
    expect(saida).toContain('x-google-start-bitrate=4000');
    // Uma por variante de H.264, e só nelas.
    expect(saida.match(/x-google-start-bitrate=/g)).toHaveLength(2);
  });

  it('SUBSTITUI um valor anterior em vez de acumular', () => {
    const uma = afinarSdp(SDP, { startBitrateBps: 4_000_000 });
    const duas = afinarSdp(uma, { startBitrateBps: 1_500_000 });
    expect(duas).toContain('x-google-start-bitrate=1500');
    expect(duas).not.toContain('x-google-start-bitrate=4000');
    expect(duas.match(/x-google-start-bitrate=/g)).toHaveLength(2);
  });

  it('sem alvo, não injeta nada', () => {
    for (const alvo of [null, undefined, 0, Number.NaN]) {
      expect(afinarSdp(SDP, { startBitrateBps: alvo })).not.toContain('x-google-start-bitrate');
    }
  });

  /**
   * O piso ficou de fora de propósito: ele obriga o encoder a manter uma taxa
   * que o link pode não ter, e gastar upload que não existe é exatamente o que
   * faz o ping do jogo subir. Ver o cabeçalho de `sdp-tuning.ts`.
   */
  it('NUNCA injeta x-google-min-bitrate', () => {
    expect(afinarSdp(SDP, { startBitrateBps: 8_000_000 })).not.toContain('min-bitrate');
  });
});

describe('afinarSdp — o que não pode tocar', () => {
  it('deixa a seção de áudio idêntica', () => {
    const saida = afinarSdp(SDP, { startBitrateBps: 4_000_000 });
    expect(saida).toContain('a=fmtp:111 minptime=10;useinbandfec=1');
  });

  it('preserva as quebras CRLF — SDP com \\n solto é recusado', () => {
    const saida = afinarSdp(SDP, { startBitrateBps: 4_000_000 });
    expect(saida.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
  });

  it('mantém a contagem de linhas', () => {
    const saida = afinarSdp(SDP, { startBitrateBps: 4_000_000 });
    expect(saida.split('\r\n')).toHaveLength(SDP.split('\r\n').length);
  });

  it('devolve entrada vazia ou inválida sem quebrar', () => {
    expect(afinarSdp('')).toBe('');
    expect(afinarSdp('lixo sem m=')).toBe('lixo sem m=');
  });
});
