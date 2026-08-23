import { describe, expect, it } from 'vitest';
import { PRESETS } from '@tela/shared';
import { statsReport } from '../mesh/testing.js';
import {
  MAX_PEERS,
  adviseFor,
  estimateUploadMbps,
  maxPeersFor,
  selectPreset,
} from './bandwidth-probe.js';

describe('maxPeersFor', () => {
  it('fibra simétrica comporta o teto do mesh', () => {
    expect(maxPeersFor(100, PRESETS.p1080p60)).toBe(MAX_PEERS);
  });

  it('30 Mbps de upload comporta dois em 1080p60', () => {
    // 30 × 0,75 = 22,5 Mbps ÷ 8 = 2
    expect(maxPeersFor(30, PRESETS.p1080p60)).toBe(2);
  });

  it('nunca devolve zero — o transmissor sempre pode tentar com um', () => {
    expect(maxPeersFor(1, PRESETS.p1080p60)).toBe(1);
    expect(maxPeersFor(0, PRESETS.p1080p60)).toBe(1);
  });

  it('medição inválida não vira teto sem sentido', () => {
    for (const ruim of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const n = maxPeersFor(ruim, PRESETS.p1080p60);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it('o mesmo link comporta mais gente em preset menor', () => {
    expect(maxPeersFor(10, PRESETS.p1080p60)).toBe(1);
    expect(maxPeersFor(10, PRESETS.p720p60eco)).toBe(3);
  });
});

describe('selectPreset', () => {
  it('escolhe pelo upload disponível', () => {
    expect(selectPreset(100)).toBe('p1080p60');
    expect(selectPreset(12)).toBe('p1080p60');
    expect(selectPreset(8)).toBe('p720p60');
    expect(selectPreset(4)).toBe('p720p60eco');
    expect(selectPreset(2)).toBe('p720p30');
  });

  it('só desce para 30fps quando 60fps não cabe de jeito nenhum', () => {
    // 4 × 0,75 = 3 Mbps: ainda cabe o eco (2,5) a 60fps.
    expect(selectPreset(4)).toBe('p720p60eco');
  });

  it('sem medição confiável, sugere o degrau mais conservador', () => {
    expect(selectPreset(Number.NaN)).toBe('p720p30');
    expect(selectPreset(0)).toBe('p720p30');
  });
});

describe('adviseFor', () => {
  it('devolve preset e teto coerentes entre si', () => {
    const conselho = adviseFor(30);
    expect(conselho.presetId).toBe('p1080p60');
    expect(conselho.maxPeers).toBe(2);
  });

  it('link ruim ainda comporta alguém, em qualidade menor', () => {
    const conselho = adviseFor(3);
    expect(conselho.presetId).toBe('p720p30');
    expect(conselho.maxPeers).toBeGreaterThanOrEqual(1);
  });
});

describe('estimateUploadMbps', () => {
  const par = (bps: number) => ({
    type: 'candidate-pair',
    state: 'succeeded',
    availableOutgoingBitrate: bps,
  });

  it('soma a banda disponível de todos os peers', () => {
    const reports = [statsReport([par(4_000_000)]), statsReport([par(4_000_000)])];
    expect(estimateUploadMbps(reports)).toBe(8);
  });

  it('devolve null enquanto não há medição — em vez de chutar', () => {
    expect(estimateUploadMbps([statsReport([])])).toBeNull();
    expect(estimateUploadMbps([])).toBeNull();
  });

  it('ignora par de candidatos que não venceu', () => {
    const perdedor = { type: 'candidate-pair', state: 'failed', availableOutgoingBitrate: 9e9 };
    expect(estimateUploadMbps([statsReport([perdedor])])).toBeNull();
  });
});
