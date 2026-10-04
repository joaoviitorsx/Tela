import { describe, expect, it } from 'vitest';
import { ParametrosH264, codecDoPerfil, nomeDoPerfilIdc, perfilDaSala, perfilDoFmtp, perfilDoSps } from './perfil-h264.js';

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

describe('ParametrosH264 — todo quadro-chave sai com SPS/PPS', () => {
  const nal = (tipo: number, ...corpo: number[]) => [0, 0, 0, 1, tipo, ...corpo];
  const SPS = nal(0x67, 77, 0, 42);
  const PPS = nal(0x68, 0xee, 0x3c);
  const AUD = nal(0x09, 0xf0);
  const IDR = nal(0x65, 0x88, 0x84, 0x00);
  const q = (...partes: number[][]) => new Uint8Array(partes.flat());

  it('quadro que já traz SPS/PPS passa intacto (mesmo objeto)', () => {
    const p = new ParametrosH264();
    const quadro = q(SPS, PPS, IDR);
    expect(p.completar(quadro)).toBe(quadro);
  });

  it('quadro-chave sem SPS/PPS ganha os últimos vistos na frente (hardware que só manda no 1º IDR)', () => {
    const p = new ParametrosH264();
    p.completar(q(SPS, PPS, IDR));
    expect([...p.completar(q(IDR))]).toEqual([...SPS, ...PPS, ...IDR]);
  });

  it('com AUD, os parâmetros entram DEPOIS dele (o AUD abre a unidade)', () => {
    const p = new ParametrosH264();
    p.completar(q(AUD, SPS, PPS, IDR));
    expect([...p.completar(q(AUD, IDR))]).toEqual([...AUD, ...SPS, ...PPS, ...IDR]);
  });

  it('antes de qualquer SPS não inventa nada', () => {
    const p = new ParametrosH264();
    const quadro = q(IDR);
    expect(p.completar(quadro)).toBe(quadro);
  });

  it('SPS novo (troca de tamanho) substitui o guardado', () => {
    const p = new ParametrosH264();
    p.completar(q(SPS, PPS, IDR));
    const SPS2 = nal(0x67, 77, 0, 40);
    p.completar(q(SPS2, PPS, IDR));
    expect([...p.completar(q(IDR))]).toEqual([...SPS2, ...PPS, ...IDR]);
  });

  it('esquecer: troca de codec não carrega parâmetros velhos', () => {
    const p = new ParametrosH264();
    p.completar(q(SPS, PPS, IDR));
    p.esquecer();
    const quadro = q(IDR);
    expect(p.completar(quadro)).toBe(quadro);
  });

  it('não lê além da primeira fatia: bytes que parecem SPS dentro da imagem não contam', () => {
    const p = new ParametrosH264();
    p.completar(q(SPS, PPS, IDR));
    const falso = q(IDR, nal(0x67, 1, 2, 3));
    expect([...p.completar(falso)]).toEqual([...SPS, ...PPS, ...falso]);
  });
});
