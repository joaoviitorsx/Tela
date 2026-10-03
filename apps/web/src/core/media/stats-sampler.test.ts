import { describe, expect, it } from 'vitest';
import { StatsSampler } from './stats-sampler.js';

function report(entries: Record<string, unknown>[]): RTCStatsReport {
  return {
    forEach(callback: (value: unknown, key: string) => void) {
      entries.forEach((entry, index) => callback(entry, String(index)));
    },
  } as unknown as RTCStatsReport;
}

const outbound = (
  bytes: number,
  timestamp: number,
  extra: Record<string, unknown> = {},
  ssrc = 1,
) => ({
  type: 'outbound-rtp',
  kind: 'video',
  ssrc,
  bytesSent: bytes,
  timestamp,
  framesPerSecond: 60,
  frameWidth: 1920,
  frameHeight: 1080,
  ...extra,
});

/**
 * O sampler passou a ser chaveado por `peerId` e não pelo índice do array —
 * índice não é identidade, e quando um peer sai os seguintes deslizam.
 */
const dePeers = (...reports: RTCStatsReport[]) =>
  reports.map((report, i) => ({ peerId: `v_${i}`, report }));

describe('StatsSampler', () => {
  it('primeira leitura não tem bitrate — não há delta ainda', () => {
    const sampler = new StatsSampler('outbound');
    const stats = sampler.read(report([outbound(1_000, 1_000)]));
    expect(stats?.bitrateBps).toBe(0);
    expect(stats?.fps).toBe(60);
  });

  it('deriva bitrate do delta de bytes entre leituras', () => {
    const sampler = new StatsSampler('outbound');
    sampler.read(report([outbound(0, 1_000)]));
    // 1.000.000 bytes em 1s = 8 Mbps
    const stats = sampler.read(report([outbound(1_000_000, 2_000)]));
    expect(stats?.bitrateBps).toBe(8_000_000);
  });

  it('soma vários peers — é o total que sai do link em mesh', () => {
    const sampler = new StatsSampler('outbound');
    sampler.readMany(dePeers(report([outbound(0, 1_000, {}, 1)]), report([outbound(0, 1_000, {}, 2)])));
    const stats = sampler.readMany(
      dePeers(
        report([outbound(500_000, 2_000, {}, 1)]),
        report([outbound(500_000, 2_000, {}, 2)]),
      ),
    );
    expect(stats?.bitrateBps).toBe(8_000_000);
  });

  it('ADR 0006 A4: espectador que entra NÃO dá pico no bitrate', () => {
    const sampler = new StatsSampler('outbound');
    // Um peer transmitindo a 1 Mbps há um tempo.
    sampler.readMany(dePeers(report([outbound(0, 1_000, {}, 1)])));
    sampler.readMany(dePeers(report([outbound(125_000, 2_000, {}, 1)])));

    // Chega um segundo peer com 5 MB já acumulados no contador dele.
    const stats = sampler.readMany(
      dePeers(
        report([outbound(250_000, 3_000, {}, 1)]),
        report([outbound(5_000_000, 3_000, {}, 2)]),
      ),
    );

    // Somar contadores brutos daria um salto de ~40 Mbps que nunca existiu.
    expect(stats?.bitrateBps).toBe(1_000_000);
  });

  it('espectador que sai não deixa buraco nem delta negativo', () => {
    const sampler = new StatsSampler('outbound');
    sampler.readMany(dePeers(report([outbound(0, 1_000, {}, 1)]), report([outbound(0, 1_000, {}, 2)])));
    const stats = sampler.readMany(dePeers(report([outbound(125_000, 2_000, {}, 1)])));
    expect(stats?.bitrateBps).toBe(1_000_000);
  });

  it('reporta o PIOR rtt, não o melhor', () => {
    const sampler = new StatsSampler('outbound');
    const stats = sampler.readMany(
      dePeers(
        report([
          outbound(0, 1_000, {}, 1),
          { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.02 },
        ]),
        report([
          outbound(0, 1_000, {}, 2),
          { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.18 },
        ]),
      ),
    );
    // O melhor esconderia o amigo com problema.
    expect(stats?.rttMs).toBe(180);
  });

  it('lê qualityLimitationReason', () => {
    const sampler = new StatsSampler('outbound');
    const stats = sampler.read(
      report([outbound(0, 1_000, { qualityLimitationReason: 'cpu' })]),
    );
    expect(stats?.limitation).toBe('cpu');
  });

  it('ignora valor desconhecido de limitação', () => {
    const sampler = new StatsSampler('outbound');
    const stats = sampler.read(
      report([outbound(0, 1_000, { qualityLimitationReason: 'aliens' })]),
    );
    expect(stats?.limitation).toBe('none');
  });

  it('converte RTT do par de candidatos para milissegundos', () => {
    const sampler = new StatsSampler('outbound');
    const stats = sampler.read(
      report([
        outbound(0, 1_000),
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.142 },
      ]),
    );
    expect(stats?.rttMs).toBe(142);
  });

  it('devolve null quando não há RTP do tipo esperado', () => {
    const sampler = new StatsSampler('inbound');
    expect(sampler.read(report([outbound(0, 1_000)]))).toBeNull();
  });

  it('reset zera a base do delta', () => {
    const sampler = new StatsSampler('outbound');
    sampler.read(report([outbound(0, 1_000)]));
    sampler.reset();
    const stats = sampler.read(report([outbound(1_000_000, 2_000)]));
    expect(stats?.bitrateBps).toBe(0);
  });

  it('contador que retrocede (renegociação) não vira bitrate negativo', () => {
    const sampler = new StatsSampler('outbound');
    sampler.read(report([outbound(1_000_000, 1_000)]));
    const stats = sampler.read(report([outbound(0, 2_000)]));
    expect(stats?.bitrateBps).toBe(0);
  });
});

describe('StatsSampler — aquecimento por caminho (ADR 0030)', () => {
  const par = (banda: number) => ({
    type: 'candidate-pair',
    state: 'succeeded',
    nominated: true,
    currentRoundTripTime: 0.02,
    availableOutgoingBitrate: banda,
  });
  const relatorio = (peerId: string, bytes: number, t: number, banda: number, motivo = 'none') => ({
    peerId,
    report: report([outbound(bytes, t, { qualityLimitationReason: motivo }, peerId.length), par(banda)]),
  });

  it('o caminho novo não puxa o pior caminho nem acusa `bandwidth` enquanto sobe', () => {
    const sampler = new StatsSampler('outbound');
    // Dois caminhos assentados: nove leituras.
    for (let t = 1; t <= 9; t += 1) {
      sampler.readMany([relatorio('a', t * 2_000_000, t * 1000, 24_000_000), relatorio('b', t * 2_000_000, t * 1000, 24_000_000)]);
    }
    const t = 10;
    const stats = sampler.readMany([
      relatorio('a', t * 2_000_000, t * 1000, 24_000_000),
      relatorio('b', t * 2_000_000, t * 1000, 24_000_000),
      // Recém-chegado: metade da estimativa e `bandwidth` da própria subida.
      relatorio('novo', 0, t * 1000, 12_000_000, 'bandwidth'),
    ]);
    expect(stats?.piorAvailableBps).toBe(24_000_000);
    expect(stats?.limitation).toBe('none');
    // A leitura crua dele vai para o governador suavizar desde já.
    expect(stats?.availablePorPeer['novo']).toBe(12_000_000);
    expect(stats?.paresMedidos).toBe(3);
  });

  it('`cpu` de um caminho novo conta: é a máquina, não a subida', () => {
    const sampler = new StatsSampler('outbound');
    for (let t = 1; t <= 9; t += 1) sampler.readMany([relatorio('a', t * 2_000_000, t * 1000, 24_000_000)]);
    const stats = sampler.readMany([
      relatorio('a', 20_000_000, 10_000, 24_000_000),
      relatorio('novo', 0, 10_000, 12_000_000, 'cpu'),
    ]);
    expect(stats?.limitation).toBe('cpu');
  });

  it('caminho novo que já afoga vota na hora', () => {
    const sampler = new StatsSampler('outbound');
    for (let t = 1; t <= 9; t += 1) sampler.readMany([relatorio('a', t * 2_000_000, t * 1000, 24_000_000)]);
    // Cada caminho recebe 16 Mbps; o novo diz carregar 5.
    const stats = sampler.readMany([
      relatorio('a', 20_000_000, 10_000, 24_000_000),
      relatorio('adsl', 0, 10_000, 5_000_000, 'bandwidth'),
    ]);
    expect(stats?.piorAvailableBps).toBe(5_000_000);
    expect(stats?.limitation).toBe('bandwidth');
  });

  it('todos novos: todos votam', () => {
    const sampler = new StatsSampler('outbound');
    const stats = sampler.readMany([relatorio('a', 0, 1000, 9_000_000, 'bandwidth'), relatorio('b', 0, 1000, 7_000_000)]);
    expect(stats?.piorAvailableBps).toBe(7_000_000);
    expect(stats?.limitation).toBe('bandwidth');
  });
});

/** Rodízio de getStats (B2): leitura retida não é amostra nova. */
describe('StatsSampler — leitura retida do rodízio', () => {
  const par = (banda: number) => ({
    type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: banda, currentRoundTripTime: 0.02,
  });

  it('o bitrate do peer não lido neste tique continua somando, na última taxa real', () => {
    const sampler = new StatsSampler('outbound');
    const a0 = report([outbound(0, 1_000, {}, 1), par(9e6)]);
    const b0 = report([outbound(0, 1_000, {}, 2), par(9e6)]);
    sampler.readMany([{ peerId: 'a', report: a0 }, { peerId: 'b', report: b0 }]);
    const a1 = report([outbound(1_000_000, 2_000, {}, 1), par(9e6)]);
    const b1 = report([outbound(1_000_000, 2_000, {}, 2), par(9e6)]);
    const lido = sampler.readMany([{ peerId: 'a', report: a1 }, { peerId: 'b', report: b1 }]);
    expect(lido?.bitrateBps).toBe(16_000_000);
    // Tique seguinte: só `a` é lido; `b` volta retido (mesmo objeto, mesmo timestamp).
    const a2 = report([outbound(2_000_000, 3_000, {}, 1), par(9e6)]);
    const retido = sampler.readMany([{ peerId: 'a', report: a2 }, { peerId: 'b', report: b1, fresco: false }]);
    expect(retido?.bitrateBps).toBe(16_000_000);
    expect(retido?.frescosPorPeer).toEqual(['a']);
    // RTT e perda são sequência de leituras (ADR 0033): a retida não entra.
    expect(retido?.rttPorPeer).toEqual({ a: 20 });
  });

  it('o aquecimento por caminho conta LEITURAS, não tiques', () => {
    const sampler = new StatsSampler('outbound');
    const fresca = (t: number) => report([outbound(t * 1000, t * 1000, {}, 2), par(5e6)]);
    // `b` é lido uma vez a cada 3 tiques; `a` assenta (10 leituras) antes dele.
    let b = fresca(1);
    for (let t = 1; t <= 30; t += 1) {
      const lerB = t % 3 === 1;
      if (lerB) b = fresca(t);
      sampler.readMany([
        { peerId: 'a', report: report([outbound(t * 1000, t * 1000, {}, 1), par(30e6)]) },
        { peerId: 'b', report: b, ...(lerB ? {} : { fresco: false }) },
      ]);
    }
    // `b` foi lido 10 vezes (> 8): assentou. Se contasse tiques, teria 30; se
    // contasse mal, teria menos. O que importa: ele só votou depois da 9ª leitura.
    const antes = new StatsSampler('outbound');
    let c = fresca(1);
    let ultima = null;
    for (let t = 1; t <= 24; t += 1) {
      const lerC = t % 3 === 1;
      if (lerC) c = fresca(t);
      ultima = antes.readMany([
        { peerId: 'a', report: report([outbound(t * 1000, t * 1000, {}, 1), par(30e6)]) },
        { peerId: 'c', report: c, ...(lerC ? {} : { fresco: false }) },
      ]);
    }
    // Aos 24 tiques `c` tem 8 leituras: ainda em aquecimento, não vota (o pior caminho é o de `a`).
    expect(ultima?.piorAvailableBps).toBe(30e6);
    ultima = antes.readMany([
      { peerId: 'a', report: report([outbound(25_000, 25_000, {}, 1), par(30e6)]) },
      { peerId: 'c', report: fresca(25) },
    ]);
    // 9ª leitura: assentou, e o pior caminho passa a ser o dele.
    expect(ultima?.piorAvailableBps).toBe(5e6);
  });
});
