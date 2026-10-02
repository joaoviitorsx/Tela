import { describe, expect, it } from 'vitest';
import { FPS_MINIMO_NA_ORIGEM, LEITURAS_RUINS, VALIDADE_DO_PAI_MS, VigiaDoPai } from './vigia-do-pai.js';

/** `n` leituras de 1 s em que o filho decodifica `fps` quadros por segundo. */
function rodar(v: VigiaDoPai, n: number, fps: number, pai: number | null, inicio = { t: 0, d: 0 }) {
  let { t, d } = inicio;
  let derrubou = v.observar({ decodificados: d, agora: t });
  for (let i = 0; i < n; i += 1) {
    t += 1000;
    d += fps;
    if (pai !== null) v.relatoDoPai(pai, t);
    derrubou = v.observar({ decodificados: d, agora: t });
  }
  return derrubou;
}

describe('VigiaDoPai', () => {
  it('só troca a imagem depois do primeiro quadro decodificado', () => {
    expect(VigiaDoPai.pronto({ decodificados: 0, agora: 0 })).toBe(false);
    expect(VigiaDoPai.pronto({ decodificados: 1, agora: 0 })).toBe(true);
  });

  it('filho acompanhando o pai: fica', () => {
    expect(rodar(new VigiaDoPai(), 10, 58, 60)).toBe(false);
  });

  it('pai recebe 60 e o filho decodifica 14: derruba depois de algumas leituras', () => {
    const v = new VigiaDoPai();
    expect(rodar(v, LEITURAS_RUINS - 1, 14, 60)).toBe(false);
    expect(rodar(new VigiaDoPai(), LEITURAS_RUINS, 14, 60)).toBe(true);
  });

  it('pai recebe e o filho nada (o preto do relato): derruba', () => {
    expect(rodar(new VigiaDoPai(), LEITURAS_RUINS, 0, 30)).toBe(true);
  });

  it('tela parada no anfitrião: poucos quadros na origem não acusam ninguém', () => {
    expect(rodar(new VigiaDoPai(), 10, 0, FPS_MINIMO_NA_ORIGEM - 1)).toBe(false);
  });

  it('sem relato do pai (ou relato velho), não julga', () => {
    expect(rodar(new VigiaDoPai(), 10, 0, null)).toBe(false);
    const v = new VigiaDoPai();
    v.relatoDoPai(60, 0);
    let t = 0;
    let d = 0;
    v.observar({ decodificados: d, agora: t });
    let derrubou = false;
    for (let i = 0; i < 10; i += 1) {
      t += VALIDADE_DO_PAI_MS;
      d += 0;
      derrubou = v.observar({ decodificados: d, agora: t }) || derrubou;
    }
    expect(derrubou).toBe(false);
  });

  it('uma leitura boa zera a contagem', () => {
    const v = new VigiaDoPai();
    rodar(v, LEITURAS_RUINS - 1, 10, 60);
    expect(rodar(v, 1, 60, 60, { t: (LEITURAS_RUINS - 1) * 1000, d: (LEITURAS_RUINS - 1) * 10 })).toBe(false);
  });
});
