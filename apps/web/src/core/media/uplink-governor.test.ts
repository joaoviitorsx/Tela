import { describe, expect, it } from 'vitest';
import { PRESET_1080P60, PRESET_360P60 } from '@tela/shared';
import { UPLINK_SHARE, UplinkGovernor } from './uplink-governor.js';

/**
 * O teste central é o da oscilação.
 *
 * A versão anterior aplicava 75% da estimativa crua a cada segundo. Como o
 * estimador do WebRTC sobe, sonda e recua por natureza, o encoder recebia um
 * alvo diferente por segundo e nunca assentava — os usuários relataram
 * exatamente isso: travamento e instabilidade.
 */
const aquecer = (g: UplinkGovernor, bps: number) => {
  for (let i = 0; i < 9; i += 1) g.observe(bps, PRESET_1080P60);
};

describe('UplinkGovernor', () => {
  it('não decide nada durante o aquecimento', () => {
    const g = new UplinkGovernor();
    for (let i = 0; i < 8; i += 1) {
      expect(g.observe(4_000_000, PRESET_1080P60)).toBeNull();
    }
  });

  it('ignora leitura ausente ou absurda', () => {
    const g = new UplinkGovernor();
    for (const ruim of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(g.observe(ruim, PRESET_1080P60)).toBeNull();
    }
  });

  it('aplica um teto quando a banda não comporta o preset', () => {
    const g = new UplinkGovernor();
    aquecer(g, 4_000_000);
    // 4 Mbps × 0,75 = 3 Mbps, abaixo dos 8 Mbps do 1080p60.
    expect(g.ceiling).toBeGreaterThan(0);
    expect(g.ceiling).toBeLessThan(PRESET_1080P60.main.maxBitrate);
  });

  it('RUÍDO NÃO VIRA OSCILAÇÃO — o defeito que travava a transmissão', () => {
    const g = new UplinkGovernor();
    aquecer(g, 5_000_000);

    // Estimativa balançando ±20% a cada segundo, como o WebRTC faz de verdade.
    const ruido = [5.5, 4.6, 5.3, 4.8, 5.6, 4.5, 5.2, 4.9, 5.4, 4.7, 5.1, 5.0];
    const mudancas = ruido
      .map((mbps) => g.observe(mbps * 1_000_000, PRESET_1080P60))
      .filter((v) => v !== null);

    // Sem amortecimento seriam 12 reconfigurações do encoder em 12 segundos.
    expect(mudancas).toHaveLength(0);
  });

  it('acompanha uma queda REAL e sustentada de banda', () => {
    const g = new UplinkGovernor();
    aquecer(g, 8_000_000);
    const antes = g.ceiling;

    // A rede piorou de verdade e ficou assim.
    let mudou: number | null = null;
    for (let i = 0; i < 20; i += 1) {
      const v = g.observe(2_000_000, PRESET_1080P60);
      if (v !== null && v.bps !== null) mudou = v.bps;
    }

    expect(mudou).not.toBeNull();
    expect(mudou!).toBeLessThan(antes!);
  });

  /**
   * MUDANÇA DE COMPORTAMENTO deliberada, motivada por medição.
   *
   * Este teste exigia piso no bitrate do MENOR PRESET (1,8 Mbps). Uma
   * auditoria mediu a consequência: a leitura chega POR ESPECTADOR, então com
   * cinco espectadores num link de 6 Mbps o piso entregava 1,8 Mbps a cada
   * sender — 9 Mbps de demanda num cano de 6, 150% do link. O governador
   * existe para impedir exatamente esse afogamento, e o piso o produzia.
   *
   * O piso passou a ser absoluto e baixo: protege contra estimativa absurda,
   * não contra link ruim de verdade. Medição sustentadamente baixa não é
   * ruído, é o link — e obedecer a ela é o trabalho desta malha.
   */
  it('não estrangula até o nada, mas TAMBÉM não excede o medido', () => {
    const g = new UplinkGovernor();
    // Estimativa catastrófica e sustentada.
    for (let i = 0; i < 40; i += 1) g.observe(50_000, PRESET_1080P60);

    expect(g.ceiling).not.toBeNull();
    expect(g.ceiling!).toBeGreaterThanOrEqual(300_000);

    const g2 = new UplinkGovernor();
    // Link modesto e honesto: o teto tem que caber nele, não no menor preset.
    for (let i = 0; i < 40; i += 1) g2.observe(1_200_000, PRESET_1080P60);
    expect(g2.ceiling!).toBeLessThanOrEqual(1_200_000);
    expect(g2.ceiling!).toBeLessThan(PRESET_360P60.main.maxBitrate);
  });

  it('não aplica teto que não restringe nada', () => {
    const g = new UplinkGovernor();
    // Banda de sobra: um teto acima do preset só reconfiguraria o encoder à toa.
    aquecer(g, 100_000_000);
    expect(g.ceiling).toBeNull();
  });

  it('solta o teto quando a banda volta', () => {
    const g = new UplinkGovernor();
    aquecer(g, 3_000_000);
    expect(g.ceiling).not.toBeNull();

    /**
     * MUDANÇA DE CONTRATO deliberada. Este teste exigia que soltar o teto
     * devolvesse `PRESET_1080P60.main.maxBitrate` — e era exatamente o
     * defeito: esse número era gravado como se fosse um teto de verdade, e o
     * valor do preset ANTIGO ficava grudado. Subir a qualidade no seletor não
     * subia o bitrate, porque `min(preset, teto)` continuava escolhendo o teto
     * velho. Soltar agora devolve `{ bps: null }`: sem teto, o preset manda.
     */
    let soltou = false;
    for (let i = 0; i < 40; i += 1) {
      const v = g.observe(100_000_000, PRESET_1080P60);
      if (v !== null && v.bps === null) soltou = true;
    }
    expect(soltou).toBe(true);
    expect(g.ceiling).toBeNull();
  });

  it('reset volta ao estado inicial', () => {
    const g = new UplinkGovernor();
    aquecer(g, 3_000_000);
    g.reset();
    expect(g.ceiling).toBeNull();
    expect(g.observe(3_000_000, PRESET_1080P60)).toBeNull();
  });

  it('a folga é de 25% sobre a banda estimada', () => {
    const g = new UplinkGovernor();
    aquecer(g, 4_000_000);
    // A média já convergiu para perto de 4 Mbps.
    expect(g.ceiling).toBeCloseTo(4_000_000 * UPLINK_SHARE, -5);
  });
});
