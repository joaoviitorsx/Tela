import { describe, expect, it } from 'vitest';
import { P2P_LIMITS, p2pViewerBudget, suggestPreset } from '@tela/shared';
import { PRESETS, PRESET_IDS, isPresetId, nextPresetOnCpuPressure } from './presets.js';

describe('presets', () => {
  it('todo preset tem exatamente duas camadas (R5)', () => {
    for (const id of PRESET_IDS) expect(PRESETS[id].layers).toHaveLength(2);
  });

  it('a segunda camada é sempre menor que a primeira', () => {
    for (const id of PRESET_IDS) {
      const [alta, baixa] = PRESETS[id].layers;
      expect(baixa.width).toBeLessThan(alta.width);
      expect(baixa.encoding.maxBitrate).toBeLessThan(alta.encoding.maxBitrate);
    }
  });

  it('todo preset mantém 60fps na camada principal — resolução cai antes do framerate', () => {
    for (const id of PRESET_IDS) expect(PRESETS[id].main.maxFramerate).toBe(60);
  });

  it('degrada um degrau por vez e para no último', () => {
    expect(nextPresetOnCpuPressure('p1080p60')).toBe('p720p60');
    expect(nextPresetOnCpuPressure('p720p60')).toBe('p720p60eco');
    expect(nextPresetOnCpuPressure('p720p60eco')).toBeNull();
  });

  it('isPresetId rejeita lixo vindo do localStorage', () => {
    expect(isPresetId('p1080p60')).toBe(true);
    expect(isPresetId('4k')).toBe(false);
    expect(isPresetId(null)).toBe(false);
  });
});

describe('orçamento P2P', () => {
  it('link de 100 Mbps aguenta o teto do browser em 1080p60', () => {
    expect(p2pViewerBudget(100_000_000, PRESETS.p1080p60)).toBe(P2P_LIMITS.maxViewersBrowser);
  });

  it('link doméstico assimétrico de 30 Mbps aguenta dois em 1080p60', () => {
    expect(p2pViewerBudget(30_000_000, PRESETS.p1080p60)).toBe(2);
  });

  it('upload de 5 Mbps não aguenta ninguém em 1080p60', () => {
    expect(p2pViewerBudget(5_000_000, PRESETS.p1080p60)).toBe(0);
  });

  it('o mesmo upload de 5 Mbps aguenta um em 720p60 econômico', () => {
    expect(p2pViewerBudget(5_000_000, PRESETS.p720p60eco)).toBe(1);
  });

  it('nunca passa do teto do browser, por melhor que seja o link', () => {
    expect(p2pViewerBudget(1_000_000_000, PRESETS.p720p60eco)).toBe(
      P2P_LIMITS.maxViewersBrowser,
    );
  });

  it('sugere o melhor preset que cabe no upload dividido pelos espectadores', () => {
    expect(suggestPreset(100_000_000, 1)).toBe('p1080p60');
    expect(suggestPreset(15_000_000, 3)).toBe('p720p60eco');
    expect(suggestPreset(20_000_000, 2)).toBe('p720p60');
    expect(suggestPreset(2_000_000, 1)).toBe('p720p60eco');
  });
});
