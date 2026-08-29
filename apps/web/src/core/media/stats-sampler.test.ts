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
