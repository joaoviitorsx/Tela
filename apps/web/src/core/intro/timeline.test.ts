import { describe, expect, it } from 'vitest';
import {
  DURACAO_ABERTURA,
  quadroFinal,
  quadroReduzido,
  sampleIntro,
} from './timeline.js';

describe('sampleIntro — critérios de aceite (§13)', () => {
  it('dura 1,80 s', () => {
    expect(DURACAO_ABERTURA).toBeCloseTo(1.8, 5);
  });

  it('deixa k1 abaixo de 0,01 no handoff — senão o salto aparece na troca', () => {
    expect(sampleIntro(1.8).k1).toBeLessThanOrEqual(0.01);
    expect(sampleIntro(1.75).k1).toBeLessThanOrEqual(0.01);
  });

  it('segura o barril em 0,28 até 1,20 e só então relaxa', () => {
    expect(sampleIntro(0).k1).toBeCloseTo(0.28, 5);
    expect(sampleIntro(1.2).k1).toBeCloseTo(0.28, 5);
    expect(sampleIntro(1.5).k1).toBeLessThan(0.28);
  });

  it('termina com a câmera dentro do tubo, frontal e com FOV aberto', () => {
    const fim = quadroFinal();
    expect(fim.camera.x).toBeCloseTo(0, 5);
    expect(fim.camera.y).toBeCloseTo(0, 5);
    expect(fim.camera.z).toBeCloseTo(0.26, 5);
    expect(fim.camera.fov).toBeCloseTo(64, 5);
  });
});

describe('sampleIntro — câmera (§3)', () => {
  it('começa em 3/4 e segura até 0,50, para provar que é 3D', () => {
    expect(sampleIntro(0).camera.x).toBeCloseTo(0.38, 5);
    expect(sampleIntro(0.5).camera.x).toBeCloseTo(0.38, 5);
    expect(sampleIntro(0.5).camera.fov).toBeCloseTo(32, 5);
  });

  it('chega frontal em 1,15, antes do dolly', () => {
    const q = sampleIntro(1.15);
    expect(q.camera.x).toBeCloseTo(0, 5);
    expect(q.camera.z).toBeCloseTo(2.3, 5);
    expect(q.camera.fov).toBeCloseTo(34, 5);
  });

  it('o dolly acelera na chegada — ease-IN, não ease-out', () => {
    // Com ease-in a primeira metade do trecho anda MENOS que a segunda. Com
    // ease-out seria o contrário, e a câmera "estaciona" ao entrar no tubo.
    const meio = sampleIntro(1.15 + (1.8 - 1.15) / 2).camera.z;
    const percorridoAteOMeio = 2.3 - meio;
    const percorridoDepois = meio - 0.26;
    expect(percorridoAteOMeio).toBeLessThan(percorridoDepois);
  });
});

describe('sampleIntro — linha de ignição (§4)', () => {
  it('abre na horizontal ANTES de expandir na vertical', () => {
    // Em 0,26 a barra já atravessou a tela e ainda tem 2 px de altura. Os dois
    // ao mesmo tempo viram fade genérico; um CRT liga nesta ordem.
    const aberta = sampleIntro(0.26);
    expect(aberta.ignicao.largura).toBeCloseTo(1, 3);
    expect(aberta.ignicao.altura).toBeLessThan(0.01);
    expect(aberta.ignicao.opacidade).toBeCloseTo(1, 3);

    const expandindo = sampleIntro(0.42);
    expect(expandindo.ignicao.altura).toBeGreaterThan(0.5);
  });

  it('some antes de o chiado assumir', () => {
    expect(sampleIntro(0.5).ignicao.opacidade).toBeCloseTo(0, 3);
  });

  it('não existe antes de 0,20', () => {
    expect(sampleIntro(0.1).ignicao.opacidade).toBe(0);
  });
});

describe('sampleIntro — sintonia (§4)', () => {
  it('a interface entra por corte seco, não por fade', () => {
    expect(sampleIntro(0.88).ui).toBe(0);
    expect(sampleIntro(0.9).ui).toBe(1);
  });

  it('tem três rasgos de amplitude decrescente', () => {
    const primeiro = sampleIntro(0.91).rasgos;
    const segundo = sampleIntro(0.97).rasgos;
    const terceiro = sampleIntro(1.03).rasgos;

    expect(primeiro).toHaveLength(1);
    expect(segundo).toHaveLength(1);
    expect(terceiro).toHaveLength(1);
    expect(Math.abs(primeiro[0]!.dx)).toBeGreaterThan(Math.abs(segundo[0]!.dx));
    expect(Math.abs(segundo[0]!.dx)).toBeGreaterThan(Math.abs(terceiro[0]!.dx));
  });

  it('rasgo tem duração curta e não sobra depois dela', () => {
    expect(sampleIntro(0.95).rasgos).toHaveLength(0);
    expect(sampleIntro(1.2).rasgos).toHaveLength(0);
  });
});

describe('sampleIntro — camadas de CRT (§4)', () => {
  it('a roll bar só existe entre 0,52 e 1,50', () => {
    expect(sampleIntro(0.4).roll).toBeNull();
    expect(sampleIntro(1.0).roll).not.toBeNull();
    expect(sampleIntro(1.6).roll).toBeNull();
  });

  it('a roll bar desce, e desce de -0,2 para 1,2', () => {
    const cedo = sampleIntro(0.53).roll!;
    const tarde = sampleIntro(1.0).roll!;
    expect(cedo).toBeGreaterThanOrEqual(-0.2);
    expect(tarde).toBeGreaterThan(cedo);
    expect(tarde).toBeLessThanOrEqual(1.2);
  });

  it('scanlines e vinheta somem antes do handoff', () => {
    expect(sampleIntro(1.7).scanlines).toBeCloseTo(0, 3);
    expect(sampleIntro(1.75).vinheta).toBeCloseTo(0, 3);
    expect(quadroFinal().scanlines).toBe(0);
    expect(quadroFinal().vinheta).toBe(0);
  });

  it('o chiado entra por baixo da linha em expansão e sai na sintonia', () => {
    expect(sampleIntro(0.44).chiado).toBe(0);
    expect(sampleIntro(0.52).chiado).toBeCloseTo(1, 3);
    expect(sampleIntro(1.45).chiado).toBeCloseTo(0, 3);
  });
});

describe('quadroReduzido — §9', () => {
  it('não tem movimento de câmera: é o quadro final, parado', () => {
    const r = quadroReduzido();
    const f = quadroFinal();
    expect(r.camera).toEqual(f.camera);
  });

  it('não tem roll bar, rasgo nem barril', () => {
    const r = quadroReduzido();
    expect(r.roll).toBeNull();
    expect(r.rasgos).toHaveLength(0);
    expect(r.k1).toBe(0);
  });

  it('mantém a identidade visual: ruído parado e a interface visível', () => {
    const r = quadroReduzido();
    expect(r.chiado).toBeGreaterThan(0);
    expect(r.ui).toBe(1);
  });
});

describe('sampleIntro — bordas', () => {
  it('segura os extremos em vez de extrapolar', () => {
    expect(sampleIntro(-1)).toEqual({ ...sampleIntro(0), t: -1 });
    expect(sampleIntro(99).camera).toEqual(quadroFinal().camera);
  });
});
