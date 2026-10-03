import { describe, expect, it } from 'vitest';
import { codecDoPerfil, nomeDoPerfilIdc, perfilDaSala, perfilDoFmtp, perfilDoSps } from './perfil-h264.js';

const MAIN = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f';
const HIGH = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f';
const BASE = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';

describe('perfil H.264 da sala', () => {
  it('lê o perfil do fmtp negociado', () => {
    expect(perfilDoFmtp(MAIN)).toBe('main');
    expect(perfilDoFmtp(HIGH)).toBe('high');
    expect(perfilDoFmtp(BASE)).toBe('baseline');
    expect(perfilDoFmtp('packetization-mode=1')).toBeNull();
    expect(perfilDoFmtp(undefined)).toBeNull();
  });

  it('Main só se TODOS aceitam; um Baseline (Firefox) puxa a sala', () => {
    expect(perfilDaSala([MAIN, HIGH, MAIN], false)).toBe('main');
    expect(perfilDaSala([MAIN, BASE], false)).toBe('baseline');
    expect(perfilDaSala([MAIN, null], false)).toBe('baseline');
  });

  it('ninguém assistindo: sem decisão; cascata: Baseline', () => {
    expect(perfilDaSala([], false)).toBeNull();
    expect(perfilDaSala([MAIN, MAIN], true)).toBe('baseline');
    expect(perfilDaSala([], true)).toBe('baseline');
  });

  it('a string do WebCodecs', () => {
    expect(codecDoPerfil('main')).toBe('avc1.4d002a');
    expect(codecDoPerfil('baseline')).toBe('avc1.42e02a');
  });

  it('o perfil emitido sai do SPS, com prefixo de 3 ou 4 bytes', () => {
    // AUD, depois SPS (nal 0x67) com profile_idc 77.
    const quatro = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 77, 0x40, 0x2a]);
    expect(perfilDoSps(quatro)).toBe(77);
    const tres = new Uint8Array([0, 0, 1, 0x67, 66, 0xe0, 0x2a]);
    expect(perfilDoSps(tres)).toBe(66);
    expect(perfilDoSps(new Uint8Array([0, 0, 1, 0x65, 0x88, 0x84]))).toBeNull();
    expect(perfilDoSps(new Uint8Array([]))).toBeNull();
  });

  it('nome para o console', () => {
    expect(nomeDoPerfilIdc(77)).toBe('Main');
    expect(nomeDoPerfilIdc(66)).toBe('Baseline');
    expect(nomeDoPerfilIdc(null)).toBeNull();
  });
});
