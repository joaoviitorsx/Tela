import { describe, expect, it } from 'vitest';
import {
  AMPLITUDE_RAD,
  LIMITE_RAD,
  PERIODO_S,
  poseParada,
  poseVitrine,
  type EntradaPose,
} from './pose.js';

const REPOUSO: EntradaPose = { t: 0, ponteiro: null, impulso: 0 };

describe('poseVitrine — o pêndulo', () => {
  it('sai do centro e volta ao centro num período', () => {
    expect(poseVitrine(REPOUSO).rotY).toBeCloseTo(0, 6);
    expect(poseVitrine({ ...REPOUSO, t: PERIODO_S }).rotY).toBeCloseTo(0, 6);
  });

  it('alcança a amplitude cheia em um quarto de período, para cada lado', () => {
    expect(poseVitrine({ ...REPOUSO, t: PERIODO_S / 4 }).rotY).toBeCloseTo(AMPLITUDE_RAD, 6);
    expect(poseVitrine({ ...REPOUSO, t: (3 * PERIODO_S) / 4 }).rotY).toBeCloseTo(-AMPLITUDE_RAD, 6);
  });

  it('desacelera nos extremos sem easing escrito à mão', () => {
    // O seno já faz isso: perto do pico ele anda menos que perto do centro.
    const perto = (a: number, b: number) =>
      Math.abs(poseVitrine({ ...REPOUSO, t: b }).rotY - poseVitrine({ ...REPOUSO, t: a }).rotY);
    const noCentro = perto(0, 0.4);
    const noExtremo = perto(PERIODO_S / 4 - 0.4, PERIODO_S / 4);
    expect(noExtremo).toBeLessThan(noCentro);
  });
});

describe('poseVitrine — nunca mostra as costas', () => {
  it('mantém a rotação dentro do limite em qualquer combinação', () => {
    // Varre o período inteiro com o ponteiro nos cantos e o clique no auge.
    for (let t = 0; t <= PERIODO_S; t += 0.05) {
      for (const px of [-1, 0, 1]) {
        for (const py of [-1, 0, 1]) {
          const pose = poseVitrine({ t, ponteiro: { x: px, y: py }, impulso: 1 });
          expect(Math.abs(pose.rotY)).toBeLessThan(LIMITE_RAD);
          expect(Math.abs(pose.rotX)).toBeLessThan(LIMITE_RAD);
        }
      }
    }
  });
});

describe('poseVitrine — ponteiro e clique', () => {
  it('inclina na direção do cursor, não para longe dele', () => {
    const centro = poseVitrine(REPOUSO);
    const direita = poseVitrine({ ...REPOUSO, ponteiro: { x: 1, y: 0 } });
    const acima = poseVitrine({ ...REPOUSO, ponteiro: { x: 0, y: -1 } });
    expect(direita.rotY).toBeGreaterThan(centro.rotY);
    expect(acima.rotX).toBeGreaterThan(centro.rotX);
  });

  it('o clique recua a escala e joga chiado na tela', () => {
    const parado = poseVitrine(REPOUSO);
    const batido = poseVitrine({ ...REPOUSO, impulso: 1 });
    expect(batido.escala).toBeLessThan(parado.escala);
    expect(batido.escala).toBeGreaterThan(0.9);
    expect(batido.chiado).toBe(1);
    expect(parado.chiado).toBe(0);
  });

  it('sem ponteiro e sem clique, sobra só o pêndulo', () => {
    const pose = poseVitrine({ t: 3.2, ponteiro: null, impulso: 0 });
    // `toBeCloseTo` e não `toBe`: sem ponteiro o cálculo é `-(0)`, que em
    // JavaScript é `-0`, e `Object.is(-0, 0)` é falso. O valor está certo.
    expect(pose.rotX).toBeCloseTo(0, 10);
    expect(pose.escala).toBe(1);
    expect(pose.chiado).toBe(0);
  });
});

describe('poseParada — prefers-reduced-motion', () => {
  it('é um 3/4, não uma pose frontal', () => {
    // Parado E frontal, o modelo vira imagem e não há motivo para ser 3D.
    expect(poseParada().rotY).toBeGreaterThan(0.1);
  });

  it('não tem flutuação, recuo nem chiado', () => {
    const p = poseParada();
    expect(p.alturaY).toBe(0);
    expect(p.escala).toBe(1);
    expect(p.chiado).toBe(0);
  });
});
