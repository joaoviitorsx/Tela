import { describe, expect, it } from 'vitest';
import {
  REGISTRO_INICIAL,
  deveBipar,
  proximoRegistro,
  tituloDaAba,
} from './aviso-de-canal.js';

describe('proximoRegistro', () => {
  it('nasce esperando e continua esperando enquanto sonda', () => {
    let r = REGISTRO_INICIAL;
    for (const status of ['checking', 'offline', 'connecting', 'offline'] as const) {
      r = proximoRegistro(r, status, false, 1);
    }
    expect(r).toEqual({ fase: 'esperando', terminouEm: null });
  });

  it('com imagem é ao vivo, também no soluço de rede que mantém o stream', () => {
    const vivo = proximoRegistro(REGISTRO_INICIAL, 'watching', true, 10);
    expect(vivo.fase).toBe('ao-vivo');
    expect(proximoRegistro(vivo, 'reconnecting', true, 20)).toBe(vivo);
  });

  it('já ao vivo, voltar a procurar o canal é "encerrada", com a hora', () => {
    const vivo = proximoRegistro(REGISTRO_INICIAL, 'watching', true, 10);
    expect(proximoRegistro(vivo, 'offline', false, 99)).toEqual({ fase: 'encerrada', terminouEm: 99 });
  });

  it('encerrada sobrevive às sondagens e só sai quando a imagem volta', () => {
    const fim = { fase: 'encerrada', terminouEm: 99 } as const;
    expect(proximoRegistro(fim, 'connecting', false, 120)).toBe(fim);
    expect(proximoRegistro(fim, 'offline', false, 130)).toBe(fim);
    expect(proximoRegistro(fim, 'watching', true, 140)).toEqual({ fase: 'ao-vivo', terminouEm: null });
  });

  it('reconectando sem imagem não conta como ao vivo', () => {
    expect(proximoRegistro(REGISTRO_INICIAL, 'reconnecting', false, 1)).toBe(REGISTRO_INICIAL);
  });
});

describe('tituloDaAba', () => {
  it('um título e um glifo por fase', () => {
    expect(tituloDaAba('jv', 'esperando')).toBe('◌ aguardando · jv');
    expect(tituloDaAba('jv', 'ao-vivo')).toBe('● AO VIVO · jv');
    expect(tituloDaAba('jv', 'encerrada')).toBe('■ encerrada · jv');
  });
});

describe('deveBipar', () => {
  it('só quando a imagem acaba de chegar', () => {
    expect(deveBipar('esperando', 'ao-vivo')).toBe(true);
    expect(deveBipar('encerrada', 'ao-vivo')).toBe(true);
    expect(deveBipar('ao-vivo', 'ao-vivo')).toBe(false);
    expect(deveBipar('ao-vivo', 'encerrada')).toBe(false);
  });
});
