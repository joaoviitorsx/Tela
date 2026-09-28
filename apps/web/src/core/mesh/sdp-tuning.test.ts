import { describe, expect, it } from 'vitest';
import { afinarSdp, NIVEL_1080P60, pedirEstereo } from './sdp-tuning.js';

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

describe('afinarSdp — nível do H.264 (ADR 0020)', () => {
  it('por padrão PRESERVA o nível que o receptor anunciou — não inventa capacidade', () => {
    const saida = afinarSdp(SDP, { startBitrateBps: 4_000_000 });
    expect(saida).toContain('profile-level-id=42e01f');
    expect(saida).toContain('profile-level-id=640c1f');
    expect(saida).not.toContain('2a');
  });

  it('com nível explícito, sobe só o byte de nível em toda variante', () => {
    const saida = afinarSdp(SDP, { nivelH264: NIVEL_1080P60 });
    expect(saida).toContain('profile-level-id=42e02a');
    expect(saida).toContain('profile-level-id=640c2a');
    expect(saida).not.toContain('01f');
  });

  it('PRESERVA profile_idc e profile_iop — é por eles que a negociação casa', () => {
    const saida = afinarSdp(SDP, { nivelH264: NIVEL_1080P60 });
    expect(saida).toContain('profile-level-id=42e0');
    expect(saida).toContain('profile-level-id=640c');
  });

  it('não REBAIXA um nível que já está acima do pedido', () => {
    const alto = SDP.replace('42e01f', '42e034');
    expect(afinarSdp(alto, { nivelH264: NIVEL_1080P60 })).toContain('profile-level-id=42e034');
  });

  it('nível inválido é ignorado, não aplicado', () => {
    for (const nivel of [0, -1, 256, 1.5, Number.NaN]) {
      expect(afinarSdp(SDP, { nivelH264: nivel })).toContain('profile-level-id=42e01f');
    }
  });

  it('é idempotente — rodar duas vezes dá o mesmo SDP', () => {
    const opcoes = { startBitrateBps: 4_000_000, nivelH264: NIVEL_1080P60 };
    const uma = afinarSdp(SDP, opcoes);
    expect(afinarSdp(uma, opcoes)).toBe(uma);
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
  it('não injeta start-bitrate no áudio', () => {
    const saida = afinarSdp(SDP, { startBitrateBps: 4_000_000 });
    const audio = saida.slice(saida.indexOf('m=audio'), saida.indexOf('m=video'));
    expect(audio).not.toContain('x-google-start-bitrate');
    expect(audio).not.toContain('profile-level-id');
    // O que já estava lá continua lá.
    expect(audio).toContain('minptime=10');
    expect(audio).toContain('useinbandfec=1');
  });

  it('LIGA o estéreo do Opus — 128 kbps estavam comprando um canal só', () => {
    /*
      Capturamos em estéreo (`channelCount: 2`) e pagamos 128 kbps, mas o
      libwebrtc negocia mono a menos que o fmtp peça:

          inline constexpr int kOpusDefaultStereo = 0;
          int GetChannelCount(f) { return param == "1" ? 2 : 1; }

      Custo de ligar: zero bit a mais — o bitrate já estava pago.
    */
    const saida = afinarSdp(SDP);
    expect(saida).toContain('stereo=1');
    expect(saida).toContain('sprop-stereo=1');
  });

  it('o estéreo também é idempotente', () => {
    const uma = afinarSdp(SDP);
    expect(afinarSdp(uma)).toBe(uma);
    expect(uma.match(/[^-]stereo=1/g)).toHaveLength(1);
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

describe('afinarSdp — Opus pelo payload type (TELA-011)', () => {
  const audio = (linhas: string[], eol = '\r\n') =>
    ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 109 63 126', ...linhas, '']
      .join(eol);

  it('acha o Opus em payload type diferente de 111', () => {
    const sdp = audio(['a=rtpmap:109 opus/48000/2', 'a=fmtp:109 useinbandfec=1']);
    expect(afinarSdp(sdp)).toContain('a=fmtp:109 useinbandfec=1;stereo=1;sprop-stereo=1');
  });

  it('não toca RED nem telephone-event, mesmo com parâmetros parecidos', () => {
    const sdp = audio([
      'a=rtpmap:109 opus/48000/2', 'a=fmtp:109 minptime=10',
      'a=rtpmap:63 red/48000/2', 'a=fmtp:63 109/109',
      'a=rtpmap:126 telephone-event/8000', 'a=fmtp:126 0-15;minptime=10',
    ]);
    const saida = afinarSdp(sdp);
    expect(saida).toContain('a=fmtp:63 109/109\r\n');
    expect(saida).toContain('a=fmtp:126 0-15;minptime=10\r\n');
  });

  it('Opus sem fmtp não ganha fmtp inventado; sem Opus, nada muda', () => {
    const semFmtp = audio(['a=rtpmap:109 opus/48000/2']);
    expect(afinarSdp(semFmtp)).toBe(semFmtp);
    const semOpus = audio(['a=rtpmap:0 PCMU/8000']);
    expect(afinarSdp(semOpus)).toBe(semOpus);
  });

  it('LF puro também funciona, e a renegociação é idempotente', () => {
    const sdp = audio(['a=rtpmap:109 opus/48000/2', 'a=fmtp:109 minptime=10'], '\n');
    const uma = afinarSdp(sdp);
    expect(uma).toContain('a=fmtp:109 minptime=10;stereo=1;sprop-stereo=1\n');
    expect(afinarSdp(uma)).toBe(uma);
  });
});

describe('pedirEstereo — preferência do receptor (TELA-011)', () => {
  it('só stereo, só no Opus, idempotente', () => {
    const sdp = ['v=0', 'm=audio 9 X 109 63', 'a=rtpmap:109 opus/48000/2', 'a=fmtp:109 minptime=10',
      'a=rtpmap:63 red/48000/2', 'a=fmtp:63 109/109', 'm=video 9 X 96', 'a=fmtp:96 profile-level-id=42e01f', ''].join('\r\n');
    const uma = pedirEstereo(sdp);
    expect(uma).toContain('a=fmtp:109 minptime=10;stereo=1\r\n');
    expect(uma).toContain('a=fmtp:63 109/109\r\n');
    expect(uma).toContain('a=fmtp:96 profile-level-id=42e01f\r\n');
    expect(uma).not.toContain('sprop');
    expect(pedirEstereo(uma)).toBe(uma);
  });
});
