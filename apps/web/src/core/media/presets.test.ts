import { describe, expect, it } from 'vitest';
import { P2P_LIMITS, SIXTY_FPS_PRESETS, p2pViewerBudget, suggestPreset } from '@tela/shared';
import { PRESETS, PRESET_IDS as PRESET_ORDER, isPresetId, nextPresetOnCpuPressure } from './presets.js';

describe('presets', () => {
  it('todo preset tem exatamente duas camadas (R5)', () => {
    for (const id of PRESET_ORDER) expect(PRESETS[id].layers).toHaveLength(2);
  });

  it('a segunda camada é sempre menor que a primeira', () => {
    for (const id of PRESET_ORDER) {
      const [alta, baixa] = PRESETS[id].layers;
      expect(baixa.width).toBeLessThan(alta.width);
      expect(baixa.encoding.maxBitrate).toBeLessThan(alta.encoding.maxBitrate);
    }
  });

  it('resolução e bitrate caem antes do framerate, em TODOS os degraus', () => {
    for (const id of SIXTY_FPS_PRESETS) expect(PRESETS[id].main.maxFramerate).toBe(60);
    const excecoes = PRESET_ORDER.filter((id) => PRESETS[id].main.maxFramerate < 60);
    // A escada recalibrada não tem exceção: todo degrau preserva 60fps, e a
    // regra do produto é perder resolução antes de framerate.
    expect(excecoes).toEqual([]);
  });

  it('a escada de presets desce monotonicamente em bitrate', () => {
    const bitrates = PRESET_ORDER.map((id) => PRESETS[id].main.maxBitrate);
    expect([...bitrates].sort((a, b) => b - a)).toEqual(bitrates);
  });

  /**
   * A escada foi recalibrada por bits por pixel e todos os degraus passaram a
   * ser 60fps, então a exceção que este teste protegia deixou de existir: não
   * há mais um degrau com a MESMA resolução do anterior, que cortaria
   * framerate sem aliviar o encoder. Agora cada degrau tira pixel de verdade,
   * e a escada pode andar até o fim.
   */
  it('degrada um degrau por vez, até o último', () => {
    expect(nextPresetOnCpuPressure('p1080p60')).toBe('p900p60');
    expect(nextPresetOnCpuPressure('p900p60')).toBe('p720p60');
    expect(nextPresetOnCpuPressure('p720p60')).toBe('p600p60');
    expect(nextPresetOnCpuPressure('p600p60')).toBe('p480p60');
    expect(nextPresetOnCpuPressure('p480p60')).toBe('p360p60');
    expect(nextPresetOnCpuPressure('p360p60')).toBeNull();
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

  /**
   * Substitui o teste que provava que `p720p30` tinha a MESMA resolução do
   * degrau acima — o defeito que motivou a recalibração. Agora a invariante é
   * a oposta: todo degrau precisa tirar pixel do encoder, senão descer nele
   * não alivia nada.
   */
  it('todo degrau tira pixel do anterior', () => {
    const areas = PRESET_ORDER.map((id) => {
      const [principal] = PRESETS[id].layers;
      return principal.width * principal.height;
    });
    for (let i = 1; i < areas.length; i += 1) {
      expect(areas[i]!).toBeLessThan(areas[i - 1]!);
    }
  });

  /**
   * O defeito que produzia o quadriculado relatado: a tabela vendia resolução
   * sem dar bits para ela. Variava de 0,045 a 0,072 bpp conforme o degrau, sem
   * critério, e movimento alto pede 0,10 a 0,20.
   */
  it('todo degrau entrega pelo menos 0,09 bit por pixel', () => {
    for (const id of PRESET_ORDER) {
      const preset = PRESETS[id];
      const [principal] = preset.layers;
      const pixelsPorSegundo = principal.width * principal.height * preset.main.maxFramerate;
      const bpp = preset.main.maxBitrate / pixelsPorSegundo;
      expect(bpp).toBeGreaterThanOrEqual(0.09);
    }
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

  /**
   * 30 × 0,7 = 21 Mbps, e 1080p60 passou a custar 12 Mbps por espectador — a
   * tabela antiga dizia 8 e entregava imagem em bloco por falta de bits.
   * Portanto UM, não dois. O número caiu porque a promessa ficou honesta.
   */
  it('link doméstico de 30 Mbps aguenta um em 1080p60', () => {
    expect(p2pViewerBudget(30_000_000, PRESETS.p1080p60)).toBe(1);
  });

  it('upload de 5 Mbps não aguenta ninguém em 1080p60', () => {
    expect(p2pViewerBudget(5_000_000, PRESETS.p1080p60)).toBe(0);
  });

  it('o mesmo upload de 5 Mbps aguenta um em 480p60', () => {
    expect(p2pViewerBudget(5_000_000, PRESETS.p480p60)).toBe(1);
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
    expect(suggestPreset(Number.NaN, 1)).toBe('p360p60');
    expect(suggestPreset(0, 1)).toBe('p360p60');
  });

  it('nunca passa do teto do browser, por melhor que seja o link', () => {
    expect(p2pViewerBudget(1_000_000_000, PRESETS.p480p60)).toBe(
      P2P_LIMITS.maxViewersBrowser,
    );
  });

  it('sugere o melhor preset que cabe no upload dividido pelos espectadores', () => {
    expect(suggestPreset(100_000_000, 1)).toBe('p1080p60');
    // 20 × 0,7 / 2 = 7 Mbps por espectador → cabe 720p60 (5,5), não 900p (8).
    expect(suggestPreset(20_000_000, 2)).toBe('p720p60');
    // 15 × 0,7 / 3 = 3,5 Mbps → 480p60 (2,5), porque 600p pede 3,6.
    expect(suggestPreset(15_000_000, 3)).toBe('p480p60');
    // 2 × 0,7 = 1,4 Mbps: o piso da escada, e ele ainda entrega 60fps.
    expect(suggestPreset(2_000_000, 1)).toBe('p360p60');
  });

  /**
   * A escada não desce mais para 30fps em degrau nenhum: no orçamento onde o
   * `p720p30` vivia cabe 360p60, que preserva o movimento — que é a
   * informação em gameplay.
   */
  it('nenhum degrau abre mão dos 60fps, nem no piso', () => {
    // 4 Mbps × 0,7 = 2,8 Mbps → 480p60 a 2,5 Mbps.
    expect(suggestPreset(4_000_000, 1)).toBe('p480p60');
    for (const id of PRESET_ORDER) expect(PRESETS[id].main.maxFramerate).toBe(60);
  });
});
