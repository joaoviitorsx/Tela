import { describe, expect, it } from 'vitest';
import { BPP_PISO, P2P_LIMITS, SIXTY_FPS_PRESETS, p2pViewerBudget, suggestPreset } from '@tela/shared';
import {
  PRESETS,
  PRESET_IDS,
  PRESET_IDS as PRESET_ORDER,
  isPresetId,
  menorPreset,
  nextPresetOnCpuPressure,
  presetParaOrcamento,
} from './presets.js';

describe('presets', () => {
  /**
   * Estes dois testes exigiam DUAS camadas de simulcast por preset, e a
   * segunda menor que a primeira. Eram verdade na topologia de SFU, onde o
   * servidor escolhe a camada por espectador.
   *
   * Em malha P2P cada conexão tem UM receptor e o controle de congestionamento
   * dela já adapta o encoding àquele espectador — simulcast só multiplicaria
   * encoders na máquina que está rodando o jogo. A ADR 0005 trocou a
   * topologia; o tipo e os testes ficaram descrevendo a antiga, e `layers[1]`
   * nunca foi lido em lugar nenhum do runtime.
   *
   * O que sobra é o que sempre foi usado: uma resolução, e ela tem que ser
   * coerente.
   */
  it('todo preset tem resolução válida e 16:9', () => {
    for (const id of PRESET_ORDER) {
      const { width, height } = PRESETS[id];
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(width / height).toBeCloseTo(16 / 9, 1);
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
    const areas = PRESET_ORDER.map((id) => PRESETS[id].width * PRESETS[id].height);
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
      const pixelsPorSegundo = preset.width * preset.height * preset.main.maxFramerate;
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
    /*
      O custo por espectador deixou de ser o NOMINAL do degrau e passou a ser o
      teto de bits por pixel — a topologia gasta `min(orçamento, BPP_TETO × w ×
      h × fps)`, que em 1080p60 são 16,2 Mbps e não 12. A conta antiga
      subestimava o custo e prometia mais espectadores do que cabem.

      100 × 0,75 = 75 Mbps ÷ 16,2 = 4 espectadores, não 5.
    */
    expect(p2pViewerBudget(100_000_000, PRESETS.p1080p60)).toBe(4);
    // Com 480p60 (3,8 Mbps de teto real) o limite volta a ser o do browser.
    expect(p2pViewerBudget(100_000_000, PRESETS.p480p60)).toBe(
      P2P_LIMITS.maxViewersBrowser,
    );
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
    /*
      Os números mudaram duas vezes e por dois motivos deliberados:

      - a folga passou de 0,7 para 0,75, porque existiam DUAS constantes de
        folga divergentes e o produto sugeria com uma e operava com a outra;
      - o critério passou a ser bits por pixel (`BPP_PISO × w × h × fps`) e não
        mais o rótulo de bitrate do degrau, porque três degraus da tabela têm
        nominal abaixo do piso e a escada ficava não-monótona.
    */
    expect(suggestPreset(100_000_000, 1)).toBe('p1080p60');
    // 20 × 0,75 / 2 = 7,5 Mbps → 720p60 exige 5,53 e 900p60 exige 8,64.
    expect(suggestPreset(20_000_000, 2)).toBe('p720p60');
    // 15 × 0,75 / 3 = 3,75 Mbps → 576p60 exige 3,54 e 720p60 exige 5,53.
    expect(suggestPreset(15_000_000, 3)).toBe('p600p60');
    // 2 × 0,75 = 1,5 Mbps: o piso da escada, e ele ainda entrega 60fps.
    expect(suggestPreset(2_000_000, 1)).toBe('p360p60');
  });

  /**
   * A escada não desce mais para 30fps em degrau nenhum: no orçamento onde o
   * `p720p30` vivia cabe 360p60, que preserva o movimento — que é a
   * informação em gameplay.
   */
  it('nenhum degrau abre mão dos 60fps, nem no piso', () => {
    // 4 Mbps × 0,75 = 3,0 Mbps → 480p60, que exige 2,46 (576p60 exige 3,54).
    expect(suggestPreset(4_000_000, 1)).toBe('p480p60');
    for (const id of PRESET_ORDER) expect(PRESETS[id].main.maxFramerate).toBe(60);
  });
});

describe('menorPreset e presetParaOrcamento', () => {
  it('o pior degrau vence — é a pressão que aperta mais que vale', () => {
    expect(menorPreset('p1080p60', 'p480p60')).toBe('p480p60');
    expect(menorPreset('p480p60', 'p1080p60')).toBe('p480p60');
    expect(menorPreset('p720p60', 'p720p60')).toBe('p720p60');
  });

  it('traduz orçamento em degrau com bits por pixel honestos', () => {
    // A conta do relato: 3 Mbps por espectador. Não é 1080p60, e fingir que
    // era é o que produzia a imagem borrada (ADR 0015).
    const id = presetParaOrcamento(3_000_000, 'fluidez');
    const { width, height } = PRESETS[id];
    expect(3_000_000 / (width * height * 60)).toBeGreaterThanOrEqual(BPP_PISO);
  });

  it('todo orçamento da escada rende ao menos o bpp NOMINAL do degrau', () => {
    /*
      O degrau escolhido é sempre o maior que cabe, então o orçamento nunca é
      menor que o nominal dele — e o nominal é o que a ADR 0010 calibrou.

      A comparação não é contra `BPP_PISO` cru porque a própria tabela tem dois
      degraus logo abaixo de 0,10 por arredondamento de resolução: `p900p60`
      fica em 0,0926 e `p1080p60` em 0,0965. Exigir 0,10 aqui reprovaria a
      tabela que a ADR 0010 aceitou, não o código.
    */
    for (const mbps of [1.5, 2, 3, 4, 6, 8, 12, 20]) {
      const bps = mbps * 1_000_000;
      const preset = PRESETS[presetParaOrcamento(bps, 'fluidez')];
      const { width, height } = preset;
      const nominal = preset.main.maxBitrate / (width * height * 60);
      expect(bps / (width * height * 60)).toBeGreaterThanOrEqual(nominal);
    }
  });

  it('nenhum degrau da escada fica longe do piso de 0,10 bpp', () => {
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id];
      const { width, height } = preset;
      const bpp = preset.main.maxBitrate / (width * height * 60);
      // 0,09 é a folga de arredondamento da tabela da ADR 0010, não licença
      // para acrescentar um degrau faminto: 0,064 era o valor que produzia o
      // quadriculado, e continua reprovando aqui.
      expect(bpp).toBeGreaterThanOrEqual(0.09);
      expect(bpp).toBeLessThanOrEqual(BPP_PISO * 1.2);
    }
  });

  it('nitidez cabe um degrau MAIOR pelo mesmo orçamento — 30fps paga', () => {
    const fluido = presetParaOrcamento(3_000_000, 'fluidez');
    const nitido = presetParaOrcamento(3_000_000, 'nitidez');
    expect(PRESET_IDS.indexOf(nitido)).toBeLessThan(PRESET_IDS.indexOf(fluido));
  });

  it('orçamento absurdo ou ausente cai no piso da escada, não no topo', () => {
    for (const ruim of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(presetParaOrcamento(ruim, 'fluidez')).toBe('p360p60');
    }
  });
});

describe('a escada é MONÓTONA — mais banda nunca piora a imagem (ADR 0018)', () => {
  const bppDe = (bps: number, fps: number) => {
    const { width, height } = PRESETS[presetParaOrcamento(bps, fps === 60 ? 'fluidez' : 'nitidez')];
    return bps / (width * height * fps);
  };

  it('nenhum orçamento rende MENOS bpp que um orçamento menor', () => {
    /*
      O critério era `orçamento >= maxBitrate nominal do degrau`, e três
      degraus da tabela têm nominal abaixo do piso. Resultado medido:

        7,75 Mbps -> p720p60  -> 0,140 bpp
        8,00 Mbps -> p900p60  -> 0,093 bpp   <- 3% mais banda, 34% menos
       11,75 Mbps -> p900p60  -> 0,136 bpp
       12,00 Mbps -> p1080p60 -> 0,097 bpp

      As faixas venenosas eram 8,00–8,64 e 12,00–12,44 Mbps por espectador.
    */
    let pior = Number.POSITIVE_INFINITY;
    for (let mbps = 1.5; mbps <= 30; mbps += 0.05) {
      const bpp = bppDe(mbps * 1_000_000, 60);
      pior = Math.min(pior, bpp);
      expect(bpp).toBeGreaterThanOrEqual(BPP_PISO);
    }
    expect(pior).toBeGreaterThanOrEqual(BPP_PISO);
  });

  it('as duas fronteiras que produziam a inversão agora sobem', () => {
    expect(bppDe(8_000_000, 60)).toBeGreaterThan(bppDe(7_750_000, 60));
    expect(bppDe(12_000_000, 60)).toBeGreaterThan(bppDe(11_750_000, 60));
  });

  it('vale para nitidez também', () => {
    for (let mbps = 1; mbps <= 20; mbps += 0.1) {
      expect(bppDe(mbps * 1_000_000, 30)).toBeGreaterThanOrEqual(BPP_PISO);
    }
  });
});
