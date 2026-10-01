import { describe, expect, it } from 'vitest';
import { BPP_PISO, bitrateDeReferencia, tetoDeBitrate, P2P_LIMITS, SIXTY_FPS_PRESETS, p2pViewerBudget, suggestPreset } from '@tela/shared';
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
    // Com 480p60 (4,08 Mbps de teto real) são 18 — abaixo do teto do produto,
    // que passou de 5 para 50 (ADR 0029): este link não enche uma sala de 50.
    expect(p2pViewerBudget(100_000_000, PRESETS.p480p60)).toBe(18);
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

  it('o mesmo upload de 5 Mbps aguenta um em 360p60', () => {
    /*
      O custo por espectador virou o TETO DA CURVA e não mais o nominal do
      degrau — é ele que a topologia de fato gasta. Em 480p60 são 4,08 Mbps, e
      5 × 0,75 = 3,75 não paga um. Em 360p60 são 2,50 e paga.

      A conta antiga contava 2,5 Mbps por espectador em 480p60 e prometia um
      que não cabia.
    */
    expect(p2pViewerBudget(5_000_000, PRESETS.p480p60)).toBe(0);
    expect(p2pViewerBudget(5_000_000, PRESETS.p360p60)).toBe(1);
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

  it('nunca passa do teto do produto, por melhor que seja o link', () => {
    // 1 Gbps pagaria 183 em 480p60; o produto para em 50.
    expect(p2pViewerBudget(1_000_000_000, PRESETS.p480p60)).toBe(P2P_LIMITS.maxViewers);
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
    // 20 × 0,75 / 2 = 7,5 Mbps → 720p60 exige 6,24 e 900p60 exige 9,13.
    expect(suggestPreset(20_000_000, 2)).toBe('p720p60');
    // 15 × 0,75 / 3 = 3,75 Mbps → 480p60 exige 3,14 e 576p60 exige 4,27.
    expect(suggestPreset(15_000_000, 3)).toBe('p480p60');
    // 2 × 0,75 = 1,5 Mbps: abaixo dos 1,92 que o piso pede, mas não há degrau
    // menor — a escada devolve o último e a UI mostra a verdade no bpp.
    expect(suggestPreset(2_000_000, 1)).toBe('p360p60');
  });

  /**
   * A escada não desce mais para 30fps em degrau nenhum: no orçamento onde o
   * `p720p30` vivia cabe 360p60, que preserva o movimento — que é a
   * informação em gameplay.
   */
  it('nenhum degrau abre mão dos 60fps, nem no piso', () => {
    // 4 Mbps × 0,75 = 3,0 Mbps → 360p60, porque 480p60 passou a exigir 3,14
    // com a curva do mercado. Rótulo menor, imagem mais densa: 0,217 bpp.
    expect(suggestPreset(4_000_000, 1)).toBe('p360p60');
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

  it('todo orçamento escolhido rende ao menos o PISO de bits por pixel', () => {
    /*
      Esta asserção era contra o bpp NOMINAL do degrau, e deixou de fazer
      sentido quando a escada passou a seguir `área^0,85` (ADR 0019): o nominal
      dos degraus de baixo subiu para até 0,137, acima do piso, então exigir
      que o orçamento sempre o alcance seria exigir mais do que o critério de
      seleção pede.

      A garantia que importa é a outra, e é ela que impede o quadriculado: o
      degrau escolhido nunca fica abaixo de `BPP_PISO`.
    */
    for (let mbps = 1.5; mbps <= 30; mbps += 0.05) {
      const bps = mbps * 1_000_000;
      const preset = PRESETS[presetParaOrcamento(bps, 'fluidez')];
      expect(bps / (preset.width * preset.height * 60)).toBeGreaterThanOrEqual(BPP_PISO);
    }
  });

  it('a escada segue a curva do mercado: bpp SOBE quando a resolução cai', () => {
    /*
      A tabela usava bits por pixel constante — `área^1,0`, expoente implícito
      0,910. Quatro fontes independentes usam `área^0,85`: a fórmula literal do
      OBS, o YouTube Live, o `kSimulcastFormatsVP8` do libwebrtc e o Jitsi H264.

      A razão é física: quadro menor tem menos redundância espacial para o
      encoder explorar, então cada pixel custa mais bits. Manter bpp constante
      subalimentava justamente os degraus de baixo, usados quando a rede está
      ruim — 360p60 dava 1,4 Mbps onde a curva dá 1,9.

      A assinatura da curva é esta: o bpp nominal CRESCE conforme a resolução
      cai. Se algum dia ele voltar a ser constante, esta expectativa quebra.
    */
    const bpps = PRESET_IDS.map((id) => {
      const p = PRESETS[id];
      return p.main.maxBitrate / (p.width * p.height * 60);
    });
    for (let i = 1; i < bpps.length; i += 1) {
      expect(bpps[i]!).toBeGreaterThan(bpps[i - 1]!);
    }
    /*
      E cada degrau fica DENTRO da própria faixa: entre o piso e o teto que a
      curva define para aquela resolução. `BPP_PISO` e `BPP_TETO` são os valores
      da ÂNCORA (1920×1080@60); comparar os degraus de baixo contra eles seria
      exatamente a incoerência que a curva veio corrigir.
    */
    for (const id of PRESET_IDS) {
      const p = PRESETS[id];
      expect(p.main.maxBitrate).toBeGreaterThanOrEqual(
        bitrateDeReferencia(p.width, p.height, 60) * 0.99,
      );
      expect(p.main.maxBitrate).toBeLessThanOrEqual(tetoDeBitrate(p.width, p.height, 60));
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
