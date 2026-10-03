import { describe, expect, it } from 'vitest';
import { caminhoDosCanais, canaisDoSegmento } from './canais-da-rota.js';

describe('canais da rota', () => {
  it('um canal é um canal', () => {
    expect(canaisDoSegmento('soumbra')).toEqual(['soumbra']);
  });

  it('a+b são dois, na ordem do link', () => {
    expect(canaisDoSegmento('soumbra+ana')).toEqual(['soumbra', 'ana']);
  });

  it('repetido conta uma vez', () => {
    expect(canaisDoSegmento('ana+ana')).toEqual(['ana']);
  });

  it('mais que o limite fica com os primeiros', () => {
    expect(canaisDoSegmento('ana+bia+caio')).toEqual(['ana', 'bia']);
  });

  it('qualquer pedaço inválido invalida o caminho', () => {
    expect(canaisDoSegmento('ana+')).toBeNull();
    expect(canaisDoSegmento('+ana')).toBeNull();
    expect(canaisDoSegmento('ana+B')).toBeNull();
    expect(canaisDoSegmento('ana+jv')).toBeNull();
    expect(canaisDoSegmento('ana+transmitir')).toBeNull();
  });

  it('o caminho volta na mesma ordem', () => {
    expect(caminhoDosCanais(['bia', 'ana'])).toBe('/bia+ana');
    expect(caminhoDosCanais(['ana'])).toBe('/ana');
  });
});
