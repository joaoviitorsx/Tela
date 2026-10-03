import { describe, expect, it } from 'vitest';
import { encoderSobrecarregado } from './sobrecarga-do-encoder.js';

describe('encoderSobrecarregado', () => {
  it('fila do encoder transbordando: sobrecarregado (o sinal de antes continua)', () => {
    expect(encoderSobrecarregado({ descartes: 1, msPorQuadro: 5, fps: 60, fpsAlvo: 60 })).toBe(true);
  });

  it('o caso medido: 40–165 ms por quadro, 21–41 fps a 60 — sobrecarregado mesmo sem a fila transbordar', () => {
    expect(encoderSobrecarregado({ descartes: 0, msPorQuadro: 64, fps: 27, fpsAlvo: 60 })).toBe(true);
    expect(encoderSobrecarregado({ descartes: 0, msPorQuadro: 40, fps: 41, fpsAlvo: 60 })).toBe(true);
  });

  it('hardware saudável com pipeline (latência de 2 quadros, FPS cheio): não', () => {
    expect(encoderSobrecarregado({ descartes: 0, msPorQuadro: 30, fps: 60, fpsAlvo: 60 })).toBe(false);
  });

  it('tela parada (FPS baixo, latência baixa): não', () => {
    expect(encoderSobrecarregado({ descartes: 0, msPorQuadro: 8, fps: 4, fpsAlvo: 60 })).toBe(false);
  });

  it('sem amostra de latência ou sem alvo: só a fila decide', () => {
    expect(encoderSobrecarregado({ descartes: 0, msPorQuadro: null, fps: 10, fpsAlvo: 60 })).toBe(false);
    expect(encoderSobrecarregado({ descartes: 0, msPorQuadro: 200, fps: 10, fpsAlvo: 0 })).toBe(false);
  });

  it('modo nitidez a 30 fps: o orçamento é 33 ms', () => {
    expect(encoderSobrecarregado({ descartes: 0, msPorQuadro: 50, fps: 28, fpsAlvo: 30 })).toBe(false);
    expect(encoderSobrecarregado({ descartes: 0, msPorQuadro: 90, fps: 20, fpsAlvo: 30 })).toBe(true);
  });
});
