import { describe, expect, it } from 'vitest';
import { StatsSampler } from './stats-sampler.js';

function report(entries: Record<string, unknown>[]): RTCStatsReport {
  return {
    forEach(callback: (value: unknown, key: string) => void) {
      entries.forEach((entry, index) => callback(entry, String(index)));
    },
  } as unknown as RTCStatsReport;
}

const outbound = (bytes: number, timestamp: number, extra: Record<string, unknown> = {}) => ({
  type: 'outbound-rtp',
  kind: 'video',
  bytesSent: bytes,
  timestamp,
  framesPerSecond: 60,
  frameWidth: 1920,
  frameHeight: 1080,
  ...extra,
});

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

  it('soma vários outbound-rtp — é o total que sai do link em P2P', () => {
    const sampler = new StatsSampler('outbound');
    sampler.read(report([outbound(0, 1_000), outbound(0, 1_000)]));
    const stats = sampler.read(report([outbound(500_000, 2_000), outbound(500_000, 2_000)]));
    expect(stats?.bitrateBps).toBe(8_000_000);
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
