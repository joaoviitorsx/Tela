import { describe, expect, it } from 'vitest';
import { P2P_LIMITS, SIXTY_FPS_PRESETS, p2pViewerBudget, suggestPreset } from '@tela/shared';
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

  it('resolução e bitrate caem antes do framerate — só o último degrau abre mão dos 60fps', () => {
    for (const id of SIXTY_FPS_PRESETS) expect(PRESETS[id].main.maxFramerate).toBe(60);
    // A exceção é deliberada e única: abaixo de ~3,5 Mbps a alternativa a
    // 30fps não é "60fps pior", é não transmitir (changeset 001 §7.3).
    const excecoes = PRESET_IDS.filter((id) => PRESETS[id].main.maxFramerate < 60);
    expect(excecoes).toEqual(['p720p30']);
  });

  it('a escada de presets desce monotonicamente em bitrate', () => {
    const bitrates = PRESET_IDS.map((id) => PRESETS[id].main.maxBitrate);
    expect([...bitrates].sort((a, b) => b - a)).toEqual(bitrates);
  });

  it('degrada um degrau por vez e para no último que preserva 60fps', () => {
    expect(nextPresetOnCpuPressure('p1080p60')).toBe('p720p60');
    expect(nextPresetOnCpuPressure('p720p60')).toBe('p720p60eco');
    // NÃO desce para p720p30: mesma resolução do eco, então cortaria framerate
    // sem aliviar o encoder — o oposto do que a pressão de CPU pede.
    expect(nextPresetOnCpuPressure('p720p60eco')).toBeNull();
    expect(nextPresetOnCpuPressure('p720p30')).toBeNull();
  });

  it('a escada de CPU nunca chega a um preset abaixo de 60fps', () => {
    const visitados: string[] = ['p1080p60'];
    let atual = nextPresetOnCpuPressure('p1080p60');
    while (atual !== null) {
      visitados.push(atual);
      atual = nextPresetOnCpuPressure(atual);
    }
    for (const id of visitados) {
      expect(PRESETS[id as keyof typeof PRESETS].main.maxFramerate).toBe(60);
    }
  });

  it('p720p30 não alivia CPU — só existe para upload limitado', () => {
    // Se um dia isso deixar de ser verdade, o degrau pode voltar para a escada.
    const eco = PRESETS.p720p60eco.layers.map((l) => l.width * l.height);
    const p30 = PRESETS.p720p30.layers.map((l) => l.width * l.height);
    expect(p30).toEqual(eco);
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

  it('medição falha (NaN, Infinity, zero, negativo) não vira teto sem sentido', () => {
    for (const ruim of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      const n = p2pViewerBudget(ruim, PRESETS.p1080p60);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    expect(p2pViewerBudget(Number.NaN, PRESETS.p1080p60)).toBe(0);
  });

  it('sem medição confiável, sugere o degrau mais conservador', () => {
    // Errar para baixo custa nitidez; errar para cima custa a transmissão.
    expect(suggestPreset(Number.NaN, 1)).toBe('p720p30');
    expect(suggestPreset(0, 1)).toBe('p720p30');
  });

  it('nunca passa do teto do browser, por melhor que seja o link', () => {
    expect(p2pViewerBudget(1_000_000_000, PRESETS.p720p60eco)).toBe(
      P2P_LIMITS.maxViewersBrowser,
    );
  });

  it('sugere o melhor preset que cabe no upload dividido pelos espectadores', () => {
    expect(suggestPreset(100_000_000, 1)).toBe('p1080p60');
    expect(suggestPreset(20_000_000, 2)).toBe('p720p60');
    expect(suggestPreset(15_000_000, 3)).toBe('p720p60eco');
    // 2 Mbps × 0,7 = 1,4 Mbps: nem o eco cabe. Aqui 30fps é a diferença entre
    // transmitir e não transmitir.
    expect(suggestPreset(2_000_000, 1)).toBe('p720p30');
  });

  it('só desce para 30fps quando 60fps não cabe de jeito nenhum', () => {
    // 4 Mbps × 0,7 = 2,8 Mbps → ainda cabe o eco (2,5 Mbps) a 60fps.
    expect(suggestPreset(4_000_000, 1)).toBe('p720p60eco');
  });
});
