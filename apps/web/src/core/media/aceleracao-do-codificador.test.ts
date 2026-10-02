import { describe, expect, it } from 'vitest';
import {
  AceleracaoDoCodificador,
  ESPERA_PARA_VOLTAR_MS,
  VOLTAS_PERMITIDAS,
} from './aceleracao-do-codificador.js';

describe('AceleracaoDoCodificador — modo inicial', () => {
  it('no app, com a sonda dizendo hardware: pede a GPU e afirma hardware', () => {
    const a = new AceleracaoDoCodificador(true);
    expect(a.comecar(true)).toBe('prefer-hardware');
    expect(a.classe()).toBe('hardware');
    expect(a.rotulo()).toBe('WebCodecs·hardware');
  });

  it('sem hardware: o no-preference de sempre, e aí é certo que é software', () => {
    const a = new AceleracaoDoCodificador(true);
    expect(a.comecar(false)).toBe('no-preference');
    expect(a.classe()).toBe('software');
    expect(a.rotulo()).toBe('WebCodecs·software');
  });

  it('sonda sem resposta: no-preference, e o rótulo não chuta', () => {
    const a = new AceleracaoDoCodificador(true);
    expect(a.comecar(null)).toBe('no-preference');
    expect(a.classe()).toBe('desconhecido');
    expect(a.rotulo()).toBe('WebCodecs');
  });

  it('na web (sem preferir hardware) o modo é o de hoje mesmo com GPU', () => {
    const a = new AceleracaoDoCodificador(false);
    expect(a.comecar(true)).toBe('no-preference');
    expect(a.classe()).toBe('desconhecido');
  });
});

describe('AceleracaoDoCodificador — queda e volta', () => {
  it('GPU falha: software na hora; volta depois de 30 s, depois de 60 s; na 3ª queda, fica', () => {
    const a = new AceleracaoDoCodificador(true);
    a.comecar(true);
    let t = 1_000;

    expect(a.falhou('erro', t)).toEqual({ modo: 'prefer-software', recriarJa: true });
    expect(a.rotulo()).toBe('WebCodecs·software·GPU caiu');
    expect(a.voltar(t + ESPERA_PARA_VOLTAR_MS - 1)).toBe(false);
    expect(a.voltar(t + ESPERA_PARA_VOLTAR_MS)).toBe(true);
    expect(a.modo).toBe('prefer-hardware');

    t += ESPERA_PARA_VOLTAR_MS + 5_000;
    expect(a.falhou('travou', t).recriarJa).toBe(true);
    expect(a.rotulo()).toBe('WebCodecs·software·GPU travou');
    expect(a.voltar(t + ESPERA_PARA_VOLTAR_MS)).toBe(false); // agora espera o dobro
    expect(a.voltar(t + 2 * ESPERA_PARA_VOLTAR_MS)).toBe(true);

    t += 3 * ESPERA_PARA_VOLTAR_MS;
    a.falhou('erro', t);
    expect(a.quedasDaGpu).toBe(VOLTAS_PERMITIDAS + 1);
    expect(a.voltar(t + 100 * ESPERA_PARA_VOLTAR_MS)).toBe(false);
    expect(a.modo).toBe('prefer-software');
  });

  it('falha já em software não recria na hora (não vira laço) nem conta como queda da GPU', () => {
    const a = new AceleracaoDoCodificador(true);
    a.comecar(true);
    a.falhou('erro', 0);
    expect(a.falhou('erro', 10)).toEqual({ modo: 'prefer-software', recriarJa: false });
    expect(a.quedasDaGpu).toBe(1);
  });

  it('no-preference sem GPU (Linux de sempre): erro não é queda da GPU', () => {
    const a = new AceleracaoDoCodificador(true);
    a.comecar(false);
    expect(a.falhou('erro', 0)).toEqual({ modo: 'no-preference', recriarJa: false });
    expect(a.quedasDaGpu).toBe(0);
    expect(a.rotulo()).toBe('WebCodecs·software');
  });

  it('no-preference que podia ser GPU (web no Windows): erro cai para software e volta', () => {
    const a = new AceleracaoDoCodificador(false);
    a.comecar(true);
    expect(a.falhou('erro', 0).modo).toBe('prefer-software');
    expect(a.voltar(ESPERA_PARA_VOLTAR_MS)).toBe(true);
    expect(a.modo).toBe('no-preference');
  });

  it('nova captura depois de uma queda começa em software, e a volta segue o relógio', () => {
    const a = new AceleracaoDoCodificador(true);
    a.comecar(true);
    a.falhou('erro', 0);
    expect(a.comecar(true)).toBe('prefer-software');
    expect(a.voltar(ESPERA_PARA_VOLTAR_MS)).toBe(true);
  });
});
