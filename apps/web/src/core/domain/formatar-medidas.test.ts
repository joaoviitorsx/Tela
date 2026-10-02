import { describe, expect, it } from 'vitest';
import {
  formatarBpp,
  formatarFps,
  formatarMbps,
  formatarMs,
  formatarMsPorQuadro,
} from './formatar-medidas.js';

describe('formatar-medidas', () => {
  it('fps vira inteiro com unidade separada', () => {
    expect(formatarFps(59.441252229134705)).toBe('59 fps');
    expect(formatarFps(51.44240468032747)).toBe('51 fps');
    expect(formatarFps(60)).toBe('60 fps');
  });

  it('sem medida é traço, e nunca "0 fps" nem NaN', () => {
    expect(formatarFps(0)).toBe('—');
    expect(formatarFps(Number.NaN)).toBe('—');
    expect(formatarMbps(0)).toBe('—');
    expect(formatarMs(0)).toBe('—');
    expect(formatarBpp(0)).toBe('—');
  });

  it('Mbps com uma casa e vírgula', () => {
    expect(formatarMbps(9_400_000)).toBe('9,4 Mbps');
    expect(formatarMbps(12_034_567)).toBe('12,0 Mbps');
  });

  it('milissegundos inteiros; custo por quadro com uma casa', () => {
    expect(formatarMs(47.6)).toBe('48 ms');
    expect(formatarMsPorQuadro(7.14)).toBe('7,1 ms');
  });

  it('bits por pixel com três casas e vírgula', () => {
    expect(formatarBpp(0.10734)).toBe('0,107');
  });
});
