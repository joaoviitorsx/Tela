import { describe, expect, it } from 'vitest';
import { CODEC_AV1, codecDaSala, codecDoEncoder, mimeDoCodec } from './codec-da-sala.js';

const COM_AV1 = ['video/H264', 'video/AV1', 'video/rtx'];
const SO_H264 = ['video/H264', 'video/rtx'];

describe('codec da sala (ADR 0035)', () => {
  it('AV1 só com todos decodificando e o encoder fazendo AV1 por hardware', () => {
    expect(codecDaSala([COM_AV1, COM_AV1], true, false)).toBe('av1');
    expect(codecDaSala([COM_AV1, SO_H264], true, false)).toBe('h264');
    expect(codecDaSala([COM_AV1, COM_AV1], false, false)).toBe('h264');
  });

  it('cascata: H.264; ninguém assistindo: sem decisão', () => {
    expect(codecDaSala([COM_AV1], true, true)).toBe('h264');
    expect(codecDaSala([], true, false)).toBeNull();
    expect(codecDaSala([], false, false)).toBeNull();
  });

  it('strings do encoder e do RTP', () => {
    expect(codecDoEncoder('av1', 'main')).toBe(CODEC_AV1);
    expect(codecDoEncoder('h264', 'main')).toBe('avc1.4d002a');
    expect(mimeDoCodec('av1')).toBe('video/AV1');
    expect(mimeDoCodec('h264')).toBe('video/H264');
  });
});
