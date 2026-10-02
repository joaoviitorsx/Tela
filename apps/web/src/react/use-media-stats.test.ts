// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MediaStats } from '../core/ports/media-transport.js';
import { useMediaStats } from './use-media-stats.js';

function stats(sobre: Partial<MediaStats> = {}): MediaStats {
  return {
    fps: 59.441252229134705,
    bitrateBps: 9_412_345,
    rttMs: 47.6,
    limitation: 'none',
    width: 1920,
    height: 1080,
    availableBps: null,
    piorAvailableBps: null,
    bpp: 0.10734,
    qp: null,
    encoderImplementation: 'ExternalEncoder',
    msPorQuadro: 7.14,
    recepcao: null,
    ...sobre,
  } as MediaStats;
}

describe('useMediaStats (C-02)', () => {
  it('números redondos e unidades com espaço: nada de 59.441252229134705fps', () => {
    const { result } = renderHook(() => useMediaStats(stats()));
    expect(result.current.fps).toBe('59 fps');
    expect(result.current.bitrate).toBe('9,4 Mbps');
    expect(result.current.rtt).toBe('48 ms');
    expect(result.current.bpp).toBe('0,107');
    expect(result.current.msPorQuadro).toBe('7,1 ms');
    expect(result.current.fps).not.toMatch(/\./);
  });

  it('sem medida, traço', () => {
    const { result } = renderHook(() => useMediaStats(null));
    expect(result.current.fps).toBe('—');
    expect(result.current.bitrate).toBe('—');
  });
});
