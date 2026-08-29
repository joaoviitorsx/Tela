import { describe, expect, it } from 'vitest';
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
  for (let i = 0; i < 9; i += 1) g.observe(bps);
};

describe('UplinkGovernor', () => {
  it('não decide nada durante o aquecimento', () => {
    const g = new UplinkGovernor();
    for (let i = 0; i < 8; i += 1) {
      expect(g.observe(4_000_000)).toBeNull();
    }
  });

  it('ignora leitura ausente ou absurda', () => {
    const g = new UplinkGovernor();
    for (const ruim of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(g.observe(ruim)).toBeNull();
    }
  });

  it('reporta o orçamento assim que tem medição confiável', () => {
    const g = new UplinkGovernor();
    aquecer(g, 4_000_000);
    expect(g.orcamento).toBeGreaterThan(0);
    expect(g.orcamento).toBeCloseTo(4_000_000 * UPLINK_SHARE, -5);
  });

  it('RUÍDO NÃO VIRA OSCILAÇÃO — o defeito que travava a transmissão', () => {
    const g = new UplinkGovernor();
    aquecer(g, 5_000_000);

    // Estimativa balançando ±20% a cada segundo, como o WebRTC faz de verdade.
    const ruido = [5.5, 4.6, 5.3, 4.8, 5.6, 4.5, 5.2, 4.9, 5.4, 4.7, 5.1, 5.0];
    const mudancas = ruido
      .map((mbps) => g.observe(mbps * 1_000_000))
      .filter((v) => v !== null);

    // Sem amortecimento seriam 12 reconfigurações do encoder em 12 segundos.
    expect(mudancas).toHaveLength(0);
  });

  it('acompanha uma queda REAL e sustentada de banda', () => {
    const g = new UplinkGovernor();
    aquecer(g, 8_000_000);
    const antes = g.orcamento;

    // A rede piorou de verdade e ficou assim.
    let mudou: number | null = null;
    for (let i = 0; i < 20; i += 1) {
      const v = g.observe(2_000_000);
      if (v !== null) mudou = v.bps;
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
    for (let i = 0; i < 40; i += 1) g.observe(50_000);

    expect(g.orcamento).not.toBeNull();
    expect(g.orcamento!).toBeGreaterThanOrEqual(300_000);

    const g2 = new UplinkGovernor();
    // Link modesto e honesto: o orçamento tem que caber nele.
    for (let i = 0; i < 40; i += 1) g2.observe(1_200_000);
    expect(g2.orcamento!).toBeLessThanOrEqual(1_200_000);
  });

  /**
   * MUDANÇA DE CONTRATO deliberada (ADR 0017), e é o defeito que motivou tudo.
   *
   * Este teste exigia `ceiling === null` com banda de sobra — "não aplica teto
   * que não restringe nada". A intenção era boa e a consequência foi cara:
   * quem consumia o silêncio caía no NOMINAL do preset, e o nominal é
   * calibração, não alvo.
   *
   * Um link de 800 Mbps com dois espectadores dá 300 Mbps por espectador, e o
   * encoder recebia 12 Mbps — 0,096 bit por pixel, o piso da ADR 0010, onde a
   * imagem para de quebrar e não onde ela fica boa. O caminho que gastava a
   * banda medida existia e estava trancado atrás da escassez.
   *
   * Medir é sempre útil. Quem decide como GASTAR é quem sabe a resolução.
   */
  it('banda de sobra também é medida e reportada', () => {
    const g = new UplinkGovernor();
    aquecer(g, 100_000_000);

    expect(g.orcamento).not.toBeNull();
    expect(g.orcamento!).toBeCloseTo(100_000_000 * UPLINK_SHARE, -7);
  });

  it('a banda voltando devolve um orçamento MAIOR, não um silêncio', () => {
    const g = new UplinkGovernor();
    aquecer(g, 3_000_000);
    const apertado = g.orcamento!;

    let ultimo: number | null = null;
    for (let i = 0; i < 40; i += 1) {
      const v = g.observe(100_000_000);
      if (v !== null) ultimo = v.bps;
    }

    expect(ultimo).not.toBeNull();
    expect(ultimo!).toBeGreaterThan(apertado);
    expect(g.orcamento!).toBeGreaterThan(apertado);
  });

  it('subir de banda também respeita a histerese', () => {
    const g = new UplinkGovernor();
    aquecer(g, 10_000_000);
    // 10% acima: não paga o custo de reconfigurar o encoder.
    const mudancas = Array.from({ length: 12 }, () => g.observe(11_000_000)).filter(
      (v) => v !== null,
    );
    expect(mudancas).toHaveLength(0);
  });

  it('reset volta ao estado inicial', () => {
    const g = new UplinkGovernor();
    aquecer(g, 3_000_000);
    g.reset();
    expect(g.orcamento).toBeNull();
    expect(g.observe(3_000_000)).toBeNull();
  });

  it('a folga é de 25% sobre a banda estimada', () => {
    const g = new UplinkGovernor();
    aquecer(g, 4_000_000);
    // A média já convergiu para perto de 4 Mbps.
    expect(g.orcamento).toBeCloseTo(4_000_000 * UPLINK_SHARE, -5);
  });
});
