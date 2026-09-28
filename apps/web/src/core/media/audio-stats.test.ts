import { describe, expect, it } from 'vitest';
import { AudioStatsSampler } from './audio-stats.js';
import { StatsSampler } from './stats-sampler.js';

function report(entries: Record<string, unknown>[]): RTCStatsReport {
  return {
    forEach(callback: (value: unknown, key: string) => void) {
      entries.forEach((entry, index) => callback(entry, String(index)));
    },
  } as unknown as RTCStatsReport;
}

const um = (r: RTCStatsReport) => [{ peerId: 'host', report: r }];

const codec = {
  type: 'codec',
  id: 'COT01_111',
  mimeType: 'audio/opus',
  clockRate: 48000,
  channels: 2,
  sdpFmtpLine: 'minptime=10;useinbandfec=1;stereo=1;x-google-segredo=abc;maxaveragebitrate=128000',
};

const entrada = (t: number, extra: Record<string, unknown> = {}, ssrc = 7) => ({
  type: 'inbound-rtp',
  kind: 'audio',
  ssrc,
  timestamp: t,
  codecId: 'COT01_111',
  bytesReceived: 0,
  packetsReceived: 0,
  packetsLost: 0,
  totalSamplesReceived: 0,
  concealedSamples: 0,
  concealmentEvents: 0,
  jitterBufferDelay: 0,
  jitterBufferEmittedCount: 0,
  totalAudioEnergy: 0,
  totalSamplesDuration: 0,
  jitter: 0.004,
  ...extra,
});

describe('AudioStatsSampler — recepção', () => {
  it('sem fluxo de áudio devolve null: não há áudio, não "áudio zero"', () => {
    const s = new AudioStatsSampler('inbound');
    expect(s.readMany(um(report([{ type: 'inbound-rtp', kind: 'video', timestamp: 1 }])))).toBeNull();
  });

  it('primeira leitura não inventa taxa: tudo que depende de delta é null', () => {
    const s = new AudioStatsSampler('inbound');
    const a = s.readMany(um(report([entrada(1_000), codec])));
    expect(a).not.toBeNull();
    expect(a?.bitrateBps).toBeNull();
    expect(a?.perda).toBeNull();
    expect(a?.ocultacao).toBeNull();
    expect(a?.nivel).toBeNull();
    // Instantâneo, não depende de delta.
    expect(a?.jitterMs).toBe(4);
  });

  it('deriva taxa, perda, ocultação, buffer e nível do INTERVALO', () => {
    const s = new AudioStatsSampler('inbound');
    s.readMany(um(report([entrada(1_000, {
      bytesReceived: 100_000, packetsReceived: 1_000, packetsLost: 10,
      totalSamplesReceived: 480_000, concealedSamples: 0, concealmentEvents: 2,
      jitterBufferDelay: 10, jitterBufferEmittedCount: 100_000,
      totalAudioEnergy: 1, totalSamplesDuration: 10,
    })])));
    const a = s.readMany(um(report([entrada(2_000, {
      bytesReceived: 116_000, packetsReceived: 1_045, packetsLost: 15,
      totalSamplesReceived: 528_000, concealedSamples: 4_800, concealmentEvents: 5,
      jitterBufferDelay: 3_010, jitterBufferEmittedCount: 148_000,
      totalAudioEnergy: 1.01, totalSamplesDuration: 11,
    })])));
    expect(a?.bitrateBps).toBe(128_000);
    // 5 perdidos de 50 esperados no intervalo — não 15 de 1060 da sessão.
    expect(a?.perda).toBeCloseTo(0.1);
    expect(a?.ocultacao).toBeCloseTo(0.1);
    expect(a?.eventosOcultacao).toBe(3);
    expect(a?.jitterBufferMs).toBeCloseTo(62.5);
    expect(a?.nivel).toBeCloseTo(0.1);
  });

  it('contador que volta é fluxo reiniciado: delta vira null, não negativo', () => {
    const s = new AudioStatsSampler('inbound');
    s.readMany(um(report([entrada(1_000, { bytesReceived: 50_000, packetsReceived: 500, packetsLost: 5, totalSamplesReceived: 100, concealedSamples: 10 })])));
    const a = s.readMany(um(report([entrada(2_000, { bytesReceived: 1_000, packetsReceived: 10, packetsLost: 0, totalSamplesReceived: 50, concealedSamples: 0 })])));
    expect(a?.bitrateBps).toBeNull();
    expect(a?.perda).toBeNull();
    expect(a?.ocultacao).toBeNull();
  });

  it('SSRC novo não herda a leitura do antigo', () => {
    const s = new AudioStatsSampler('inbound');
    s.readMany(um(report([entrada(1_000, { bytesReceived: 0 }, 1)])));
    const a = s.readMany(um(report([entrada(2_000, { bytesReceived: 900_000 }, 2)])));
    expect(a?.bitrateBps).toBeNull();
  });

  it('campo ausente fica desconhecido, nunca zero', () => {
    const s = new AudioStatsSampler('inbound');
    const sem = { type: 'inbound-rtp', kind: 'audio', ssrc: 3, bytesReceived: 0 };
    s.readMany(um(report([{ ...sem, timestamp: 1_000 }])));
    const a = s.readMany(um(report([{ ...sem, timestamp: 2_000, bytesReceived: 1_000 }])));
    expect(a?.bitrateBps).toBe(8_000);
    expect(a?.perda).toBeNull();
    expect(a?.ocultacao).toBeNull();
    expect(a?.jitterMs).toBeNull();
    expect(a?.nivel).toBeNull();
    expect(a?.codec).toBeNull();
  });

  it('codec: só chaves Opus conhecidas e valores numéricos entram', () => {
    const s = new AudioStatsSampler('inbound');
    const a = s.readMany(um(report([entrada(1_000), codec])));
    expect(a?.codec).toEqual({
      mimeType: 'audio/opus',
      canais: 2,
      clockRate: 48000,
      parametros: { minptime: 10, useinbandfec: 1, stereo: 1, maxaveragebitrate: 128000 },
    });
  });
});

describe('AudioStatsSampler — envio', () => {
  const saida = (t: number, bytes: number, ssrc: number) => ({
    type: 'outbound-rtp', kind: 'audio', ssrc, timestamp: t, bytesSent: bytes, packetsSent: 0,
  });
  const fonte = (t: number, energia: number, duracao: number) => ({
    type: 'media-source', kind: 'audio', id: 'SA1', timestamp: t,
    totalAudioEnergy: energia, totalSamplesDuration: duracao,
  });

  it('soma TAXAS por peer e mede o nível do que entra no encoder', () => {
    const s = new AudioStatsSampler('outbound');
    s.readMany([
      { peerId: 'a', report: report([saida(1_000, 0, 1), fonte(1_000, 0, 0)]) },
      { peerId: 'b', report: report([saida(1_000, 0, 2), fonte(1_000, 0, 0)]) },
    ]);
    const a = s.readMany([
      { peerId: 'a', report: report([saida(2_000, 16_000, 1), fonte(2_000, 0.04, 1)]) },
      { peerId: 'b', report: report([saida(2_000, 16_000, 2), fonte(2_000, 0.04, 1)]) },
    ]);
    expect(a?.fluxos).toBe(2);
    expect(a?.bitrateBps).toBe(256_000);
    expect(a?.nivel).toBeCloseTo(0.2);
    // Perda e ocultação são do receptor; o transmissor não as inventa.
    expect(a?.perda).toBeNull();
    expect(a?.ocultacao).toBeNull();
  });

  it('peer que entra não gera pico no primeiro ciclo', () => {
    const s = new AudioStatsSampler('outbound');
    s.readMany([{ peerId: 'a', report: report([saida(1_000, 0, 1)]) }]);
    const a = s.readMany([
      { peerId: 'a', report: report([saida(2_000, 16_000, 1)]) },
      { peerId: 'b', report: report([saida(2_000, 5_000_000, 2)]) },
    ]);
    expect(a?.bitrateBps).toBe(128_000);
  });
});

describe('StatsSampler carrega o áudio junto', () => {
  it('audio é null quando só há vídeo', () => {
    const s = new StatsSampler('outbound');
    const r = s.read(report([{ type: 'outbound-rtp', kind: 'video', ssrc: 1, bytesSent: 0, timestamp: 1 }]));
    expect(r?.audio).toBeNull();
  });

  it('audio anda mesmo quando a leitura de vídeo falta', () => {
    const s = new StatsSampler('inbound');
    s.read(report([entrada(1_000, { bytesReceived: 0 })]));
    const r = s.read(report([
      { type: 'inbound-rtp', kind: 'video', ssrc: 9, bytesReceived: 0, timestamp: 2_000 },
      entrada(2_000, { bytesReceived: 16_000 }),
    ]));
    expect(r?.audio?.bitrateBps).toBe(128_000);
  });
});
