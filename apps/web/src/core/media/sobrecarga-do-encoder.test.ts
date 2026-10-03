import { describe, expect, it } from 'vitest';
import { encoderSobrecarregado } from './sobrecarga-do-encoder.js';

const base = { descartes: 0, amostras: 40, fpsAlvo: 60, classe: 'hardware' as const };

describe('encoderSobrecarregado', () => {
  it('fila do encoder transbordando: sobrecarregado (o sinal de antes continua)', () => {
    expect(encoderSobrecarregado({ ...base, descartes: 1, msPorQuadro: 5, intervaloDeEntradaMs: 16.7 })).toBe(true);
  });

  it('o caso medido: fonte a ~60 fps e 64–165 ms por quadro — sobrecarregado', () => {
    expect(encoderSobrecarregado({ ...base, msPorQuadro: 64, intervaloDeEntradaMs: 20 })).toBe(true);
    expect(encoderSobrecarregado({ ...base, msPorQuadro: 130, intervaloDeEntradaMs: 25 })).toBe(true);
  });

  it('o falso positivo da revisão: fonte a 30 fps, 34–58 ms — NÃO (o encoder dá conta do que recebe)', () => {
    expect(encoderSobrecarregado({ ...base, msPorQuadro: 58, intervaloDeEntradaMs: 33.3 })).toBe(false);
  });

  it('hardware com pipeline de 2 quadros, a 60 e a 30 fps: não', () => {
    expect(encoderSobrecarregado({ ...base, msPorQuadro: 34, intervaloDeEntradaMs: 16.7 })).toBe(false);
    expect(encoderSobrecarregado({ ...base, msPorQuadro: 67, intervaloDeEntradaMs: 33.3 })).toBe(false);
  });

  it('tela parada (manterVivo a 2 Hz, poucas amostras), mesmo com um IDR lento: não', () => {
    expect(encoderSobrecarregado({ ...base, amostras: 2, msPorQuadro: 400, intervaloDeEntradaMs: 500 })).toBe(false);
  });

  it('sem amostra ou sem alvo: só a fila decide', () => {
    expect(encoderSobrecarregado({ ...base, msPorQuadro: null, intervaloDeEntradaMs: 16.7 })).toBe(false);
    expect(encoderSobrecarregado({ ...base, fpsAlvo: 0, msPorQuadro: 200, intervaloDeEntradaMs: 16.7 })).toBe(false);
  });

  it('software não tem pipeline: ~65 ms a 60 fps já é fôlego faltando (oscilava em volta de 2,5×)', () => {
    expect(encoderSobrecarregado({ ...base, classe: 'software', msPorQuadro: 65, intervaloDeEntradaMs: 16.7 })).toBe(true);
    expect(encoderSobrecarregado({ ...base, classe: 'hardware', msPorQuadro: 65, intervaloDeEntradaMs: 16.7 })).toBe(true);
    expect(encoderSobrecarregado({ ...base, classe: 'software', msPorQuadro: 20, intervaloDeEntradaMs: 16.7 })).toBe(false);
  });
});
