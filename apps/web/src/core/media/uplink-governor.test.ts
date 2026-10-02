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
  for (let i = 0; i < 9; i += 1) g.observe({ v_1: bps });
};

/** N peers reportando o mesmo valor — o caso que fechava a catraca. */
const comPeers = (n: number, bps: number): Record<string, number> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`v_${i}`, bps]));

describe('UplinkGovernor', () => {
  it('não decide nada durante o aquecimento', () => {
    const g = new UplinkGovernor();
    for (let i = 0; i < 8; i += 1) {
      expect(g.observe({ v_1: 4_000_000 })).toBeNull();
    }
  });

  it('ignora leitura ausente ou absurda', () => {
    const g = new UplinkGovernor();
    for (const ruim of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(g.observe({ v_1: ruim })).toBeNull();
    }
    // Nenhum peer reportou: não há o que medir.
    expect(g.observe({})).toBeNull();
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
      .map((mbps) => g.observe({ v_1: mbps * 1_000_000 }))
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
      const v = g.observe({ v_1: 2_000_000 });
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
    for (let i = 0; i < 40; i += 1) g.observe({ v_1: 50_000 });

    expect(g.orcamento).not.toBeNull();
    expect(g.orcamento!).toBeGreaterThanOrEqual(300_000);

    const g2 = new UplinkGovernor();
    // Link modesto e honesto: o orçamento tem que caber nele.
    for (let i = 0; i < 40; i += 1) g2.observe({ v_1: 1_200_000 });
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
      const v = g.observe({ v_1: 100_000_000 });
      if (v !== null) ultimo = v.bps;
    }

    expect(ultimo).not.toBeNull();
    expect(ultimo!).toBeGreaterThan(apertado);
    expect(g.orcamento!).toBeGreaterThan(apertado);
  });

  it('subir de banda respeita a histerese, agora com banda ESTREITA', () => {
    const g = new UplinkGovernor();
    aquecer(g, 10_000_000);
    // 3% acima: ruído, não notícia.
    const mudancas = Array.from({ length: 12 }, () => g.observe({ v_1: 10_300_000 })).filter(
      (v) => v !== null,
    );
    expect(mudancas).toHaveLength(0);
  });

  /**
   * O defeito da ADR 0018, em forma de teste.
   *
   * A histerese era simétrica em 25%, e isso exigia `media ≥ 1,667 × aplicado`
   * para subir. Mas `aplicado` VIRA o `maxBitrate` do sender, e o
   * `AimdRateControl` do libwebrtc tampa a estimativa em `1,5 × acked`. A
   * malha era estruturalmente incapaz de abrir: num link de 800 Mbps o
   * orçamento travava em 13,5 Mbps no nono segundo e não subia nunca mais.
   */
  it('SOBE quando o link tem folga — o teto do estimador é 1,5×', () => {
    const g = new UplinkGovernor();
    aquecer(g, 10_000_000);
    const antes = g.orcamento!;

    // O máximo que o estimador pode reportar com o nosso teto em vigor.
    let ultimo: number | null = null;
    for (let i = 0; i < 30; i += 1) {
      const v = g.observe({ v_1: antes * 1.5 });
      if (v !== null) ultimo = v.bps;
    }

    expect(ultimo).not.toBeNull();
    expect(ultimo!).toBeGreaterThan(antes);
  });

  it('NÃO corta por estar em regime — a catraca de mão única', () => {
    const g = new UplinkGovernor();
    aquecer(g, 10_000_000);
    const antes = g.orcamento!;

    /*
      Em ALR o estimador reporta perto da taxa reconhecida, que é o nosso
      próprio teto. Com histerese simétrica isso dava `variacao = 0,25`
      exatamente — e `0,25 < 0,25` é falso, então a malha CORTAVA 25% por
      estar funcionando. Repetido, levava a transmissão ao piso de 300 kbps.
    */
    for (let i = 0; i < 40; i += 1) g.observe({ v_1: antes });
    expect(g.orcamento!).toBeGreaterThanOrEqual(antes);
  });

  it('reset volta ao estado inicial', () => {
    const g = new UplinkGovernor();
    aquecer(g, 3_000_000);
    g.reset();
    expect(g.orcamento).toBeNull();
    expect(g.observe({ v_1: 3_000_000 })).toBeNull();
  });

  it('a folga é de 25% sobre a banda estimada', () => {
    const g = new UplinkGovernor();
    aquecer(g, 4_000_000);
    // A média já convergiu para perto de 4 Mbps.
    expect(g.orcamento).toBeCloseTo(4_000_000 * UPLINK_SHARE, -5);
  });
});

/**
 * O defeito que o simulador de 1200 cenários achou: com o mínimo entre peers e
 * ruído de ±20%, `E[min de N]` vale `0,8 + 0,4/(N+1)` da capacidade real. Esse
 * viés fechava a malha de subida a partir de DOIS espectadores — link de
 * 300 Mbps com cinco espectadores congelava em 52% do que o link pagava.
 *
 * A correção é suavizar cada caminho ANTES de tirar o mínimo.
 */
describe('UplinkGovernor — a malha abre com N espectadores (ADR 0019)', () => {
  for (const n of [1, 2, 3, 5]) {
    it(`sobe com ${n} espectador(es), mesmo com ruído de ±20%`, () => {
      const g = new UplinkGovernor();
      const capacidade = 10_000_000;
      const ruido = () => 0.8 + Math.random() * 0.4;

      for (let i = 0; i < 12; i += 1) {
        g.observe(
          Object.fromEntries(
            Array.from({ length: n }, (_, k) => [`v_${k}`, capacidade * ruido()]),
          ),
        );
      }
      const antes = g.orcamento!;

      // O link tem folga: o estimador reporta até 1,5× o que aplicamos.
      let ultimo = antes;
      for (let i = 0; i < 200; i += 1) {
        const teto = (g.orcamento ?? antes) * 1.5;
        const v = g.observe(
          Object.fromEntries(Array.from({ length: n }, (_, k) => [`v_${k}`, teto * ruido()])),
        );
        if (v !== null) ultimo = v.bps;
      }

      expect(ultimo).toBeGreaterThan(antes * 1.5);
    });
  }

  it('um peer fraco segura todo mundo, sem viés dos outros', () => {
    const g = new UplinkGovernor();
    for (let i = 0; i < 40; i += 1) {
      g.observe({ forte: 60_000_000, fraco: 5_000_000 });
    }
    // 5 Mbps × 0,75 — o mínimo verdadeiro, não a média nem o mínimo enviesado.
    expect(g.orcamento).toBeCloseTo(5_000_000 * UPLINK_SHARE, -5);
  });

  it('peer que sai para de segurar o mínimo', () => {
    const g = new UplinkGovernor();
    for (let i = 0; i < 40; i += 1) g.observe({ forte: 60_000_000, fraco: 5_000_000 });
    expect(g.orcamento!).toBeLessThan(10_000_000);

    for (let i = 0; i < 40; i += 1) g.observe({ forte: 60_000_000 });
    expect(g.orcamento!).toBeGreaterThan(10_000_000);
  });

  it('a semente NÃO cria banda morta — o orçamento chega ao encoder', () => {
    /*
      `seed()` chegou a preencher `aplicado`, e com isso a medição real caía
      dentro da histerese: `observe()` devolvia `null` para sempre, o
      transporte ficava sem orçamento e a escada de pressão também se calava.
      Medido: 101 de 306 cenários mudos, o pior deles 300s a 0,0068 bpp.
    */
    const g = new UplinkGovernor();
    g.seed(10_000_000);

    let emitiu = false;
    for (let i = 0; i < 12; i += 1) {
      if (g.observe({ v_1: 10_000_000 }) !== null) emitiu = true;
    }
    expect(emitiu).toBe(true);
    expect(g.orcamento).not.toBeNull();
  });
});

void comPeers;

describe('UplinkGovernor — aquecimento por caminho (ADR 0030)', () => {
  const cheio = 30_000_000;

  it('um caminho novo lendo baixo não derruba o mínimo enquanto sobe', () => {
    const g = new UplinkGovernor();
    aquecer(g, cheio);
    g.observe(comPeers(3, cheio));
    const antes = g.orcamento;
    // O recém-chegado parte do bitrate inicial (metade) e sobe 8 %/s; nos
    // oito primeiros segundos a leitura dele fala da subida, não do link.
    const decisoes = [];
    for (let i = 0; i < 8; i += 1) {
      decisoes.push(g.observe({ ...comPeers(3, cheio), v_novo: cheio * 0.5 * (1 + 0.08 * i) }, { enviadoPorCaminho: cheio * 0.6 }));
    }
    expect(decisoes.filter((d) => d !== null)).toHaveLength(0);
    expect(g.orcamento).toBe(antes);
  });

  it('passado o aquecimento, o caminho novo vota — e um caminho fraco de verdade derruba', () => {
    const g = new UplinkGovernor();
    aquecer(g, cheio);
    g.observe(comPeers(3, cheio));
    for (let i = 0; i < 12; i += 1) g.observe({ ...comPeers(3, cheio), v_novo: cheio * 0.4 }, { enviadoPorCaminho: cheio * 0.6 });
    expect(g.orcamento).toBeLessThan(cheio * UPLINK_SHARE * 0.5);
  });

  it('caminho novo que já afoga (menos de 60 % do que cada um recebe) vota na hora', () => {
    const g = new UplinkGovernor();
    aquecer(g, cheio);
    g.observe(comPeers(3, cheio));
    const antes = g.orcamento ?? 0;
    // Amigo em ADSL: lê 5 Mbps numa sala em que cada um recebe 20.
    const d = g.observe({ ...comPeers(3, cheio), v_adsl: 5_000_000 }, { enviadoPorCaminho: 20_000_000 });
    expect(d).not.toBeNull();
    expect(d?.bps ?? antes).toBeLessThan(antes);
  });

  it('se ninguém assentou ainda, todos votam — ficar cego seria pior', () => {
    const g = new UplinkGovernor();
    // Nove leituras de três caminhos que entraram juntos: decide na nona.
    let decisao = null;
    for (let i = 0; i < 9; i += 1) decisao = g.observe(comPeers(3, 8_000_000), { enviadoPorCaminho: 7_000_000 });
    expect(decisao).not.toBeNull();
  });
});
