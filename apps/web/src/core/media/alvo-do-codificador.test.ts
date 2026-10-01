import { PRESETS, tetoDeBitrate } from '@tela/shared';
import { describe, expect, it } from 'vitest';
import { BITRATE_MINIMO, FOLGA_DA_ESTIMATIVA, alvoDoCodificador } from './alvo-do-codificador.js';

const base = { prioridade: 'fluidez' as const, fonte: { width: 1920, height: 1080 }, piorEstimativa: null };

describe('alvoDoCodificador — o encoder único segue a regra da topologia', () => {
  it('sem medição, o nominal do degrau (bitrate de encoder empurra; não parte do teto)', () => {
    const a = alvoDoCodificador({ ...base, preset: PRESETS.p1080p60, orcamento: null });
    expect(a).toEqual({
      width: 1920, height: 1080, fps: 60, bitrate: PRESETS.p1080p60.main.maxBitrate, limitadoPelaEstimativa: false,
    });
  });

  it('com orçamento, gasta até o teto útil de bits por pixel', () => {
    const teto = tetoDeBitrate(1920, 1080, 60);
    expect(alvoDoCodificador({ ...base, preset: PRESETS.p1080p60, orcamento: 9e6 }).bitrate).toBe(9e6);
    expect(alvoDoCodificador({ ...base, preset: PRESETS.p1080p60, orcamento: 800e6 }).bitrate).toBe(Math.round(teto));
  });

  it('o freio rápido: nunca acima de 85% da pior estimativa medida agora', () => {
    const a = alvoDoCodificador({ ...base, preset: PRESETS.p1080p60, orcamento: 20e6, piorEstimativa: 8e6 });
    expect(a.bitrate).toBe(Math.round(8e6 * FOLGA_DA_ESTIMATIVA));
    // E diz que foi a estimativa: o transporte reporta `bandwidth` e a malha desce o degrau.
    expect(a.limitadoPelaEstimativa).toBe(true);
    expect(alvoDoCodificador({ ...base, preset: PRESETS.p1080p60, orcamento: 5e6, piorEstimativa: 20e6 }).limitadoPelaEstimativa).toBe(false);
  });

  it('nitidez corta para 30 fps (ADR 0015)', () => {
    expect(alvoDoCodificador({ ...base, preset: PRESETS.p1080p60, orcamento: null, prioridade: 'nitidez' }).fps).toBe(30);
  });

  it('degrau menor tira pixel da fonte; fonte menor que o degrau não ganha pixel', () => {
    expect(alvoDoCodificador({ ...base, preset: PRESETS.p720p60, orcamento: null })).toMatchObject({ width: 1280, height: 720 });
    expect(alvoDoCodificador({ ...base, preset: PRESETS.p1080p60, orcamento: null, fonte: { width: 1280, height: 720 } }))
      .toMatchObject({ width: 1280, height: 720 });
  });

  it('tela 16:10 respeita o lado que estoura, com dimensões pares', () => {
    const a = alvoDoCodificador({ ...base, preset: PRESETS.p1080p60, orcamento: null, fonte: { width: 1920, height: 1200 } });
    expect(a.height).toBe(1080);
    expect(a.width % 2).toBe(0);
    expect(a.width).toBe(1728);
  });

  it('nunca abaixo do piso', () => {
    expect(alvoDoCodificador({ ...base, preset: PRESETS.p360p60, orcamento: 10_000, piorEstimativa: 5_000 }).bitrate).toBe(BITRATE_MINIMO);
  });
});
