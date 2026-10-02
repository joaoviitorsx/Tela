import { describe, expect, it } from 'vitest';
import {
  RelogioDeCaptura,
  type ReferenciaDeCaptura,
  diferencaRtp,
  mediana,
  paraUnixMs,
} from './relogio-de-captura.js';

const NTP = 2_208_988_800_000;
const T0 = 1_790_000_000_000;

/** Transmissor com relógio `adiantoMs` à frente do nosso. */
function leitura(opcoes: {
  captureUnix: number;
  rtp: number;
  adiantoMs?: number;
  rttMs?: number;
  srEm?: number;
  ntp?: boolean;
}): ReferenciaDeCaptura {
  const adianto = opcoes.adiantoMs ?? 0;
  const rtt = opcoes.rttMs ?? 0;
  const srEm = opcoes.srEm ?? opcoes.captureUnix;
  return {
    rtpTimestamp: opcoes.rtp,
    captureTimestamp: (opcoes.ntp === false ? 0 : NTP) + opcoes.captureUnix + adianto,
    // O SR sai do transmissor em `srEm` (tempo local) → relógio dele: srEm + adianto;
    // chega aqui depois de RTT/2.
    relogio: { remotoMs: srEm + adianto, recebidoMs: srEm + rtt / 2, rttMs: rtt },
  };
}

describe('RelogioDeCaptura', () => {
  it('sem referência ou sem SR, não inventa número', () => {
    const r = new RelogioDeCaptura();
    expect(r.latenciaMs(1, 1_000, 0)).toBeNull();
    r.observar({ rtpTimestamp: 1, captureTimestamp: NTP + 1_000, relogio: null }, 0);
    expect(r.offsetMs).toBeNull();
    expect(r.latenciaMs(1, 1_100, 0)).toBeNull();
  });

  it('relógios iguais: atraso é exibição − captura', () => {
    const r = new RelogioDeCaptura();
    r.observar(leitura({ captureUnix: T0 + 0, rtp: 5_000 }), 0);
    expect(r.latenciaMs(5_000, T0 + 50, 0)).toBeCloseTo(50, 5);
  });

  it('extrapola o quadro pelo relógio RTP de 90 kHz', () => {
    const r = new RelogioDeCaptura();
    r.observar(leitura({ captureUnix: T0 + 0, rtp: 5_000 }), 0);
    // Quadro 3 passos de 16,67 ms depois (1500 ticks cada): capturado em +50 ms.
    expect(r.latenciaMs(5_000 + 4_500, T0 + 100, 0)).toBeCloseTo(50, 5);
    // E um quadro ANTERIOR à referência (rtp menor).
    expect(r.latenciaMs(5_000 - 1_800, T0 + 100, 0)).toBeCloseTo(120, 5);
  });

  it('corrige relógio do transmissor adiantado ou atrasado pelo SR (RTT/2)', () => {
    for (const adianto of [-2_500, 0, 37, 4_000]) {
      const r = new RelogioDeCaptura();
      r.observar(leitura({ captureUnix: T0 + 0, rtp: 0, adiantoMs: adianto, rttMs: 40 }), 0);
      // Offset estimado: (recebido − remoto) − RTT/2 = −adianto (a ida simétrica cancela).
      expect(r.offsetMs).toBeCloseTo(-adianto, 5);
      expect(r.latenciaMs(0, T0 + 70, 0)).toBeCloseTo(70, 5);
    }
  });

  it('assimetria do caminho vira erro de metade dela — o limite documentado', () => {
    // Ida de 30 ms, volta de 10 ms: RTT 40, RTT/2 = 20 → erro de +10 ms no offset.
    const r = new RelogioDeCaptura();
    r.observar(
      {
        rtpTimestamp: 0,
        captureTimestamp: NTP + T0 + 0,
        relogio: { remotoMs: T0 + 0, recebidoMs: T0 + 30, rttMs: 40 },
      },
      0,
    );
    expect(r.latenciaMs(0, T0 + 70, 0)).toBeCloseTo(60, 5); // verdade 70, erro 10
  });

  it('a mediana de vários SR segura um SR atrasado na fila', () => {
    const r = new RelogioDeCaptura();
    for (let i = 0; i < 9; i += 1) {
      r.observar(leitura({ captureUnix: T0 + 0 + i * 1_000, rtp: i, srEm: T0 + 0 + i * 1_000 }), 0);
    }
    // Um SR que ficou 500 ms preso numa fila.
    r.observar(
      { rtpTimestamp: 9, captureTimestamp: NTP + T0 + 9000, relogio: { remotoMs: T0 + 9000, recebidoMs: T0 + 9500, rttMs: 0 } },
      0,
    );
    expect(Math.abs(r.offsetMs ?? 999)).toBeLessThan(1);
  });

  it('o mesmo SR lido duas vezes conta uma só', () => {
    const r = new RelogioDeCaptura();
    const l = leitura({ captureUnix: T0 + 0, rtp: 0 });
    r.observar(l, 0);
    r.observar(l, 1);
    r.observar(l, 2);
    expect(r.offsetMs).toBeCloseTo(0, 5);
  });

  it('referência velha (reconexão, fluxo parado) não extrapola', () => {
    const r = new RelogioDeCaptura();
    r.observar(leitura({ captureUnix: T0 + 0, rtp: 0 }), 0);
    expect(r.latenciaMs(0, T0 + 50, 5_000)).not.toBeNull();
    expect(r.latenciaMs(0, T0 + 50, 10_001)).toBeNull();
  });

  it('reset esquece tudo', () => {
    const r = new RelogioDeCaptura();
    r.observar(leitura({ captureUnix: T0 + 0, rtp: 0 }), 0);
    r.reset();
    expect(r.offsetMs).toBeNull();
    expect(r.latenciaMs(0, T0 + 50, 0)).toBeNull();
  });

  it('aceita captureTimestamp já em Unix', () => {
    const r = new RelogioDeCaptura();
    r.observar(leitura({ captureUnix: 1_790_000_000_000, rtp: 0, ntp: false }), 0);
    expect(r.latenciaMs(0, 1_790_000_000_040, 0)).toBeCloseTo(40, 5);
  });
});

describe('helpers', () => {
  it('paraUnixMs distingue NTP de Unix', () => {
    expect(paraUnixMs(NTP + 1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(paraUnixMs(1_790_000_000_000)).toBe(1_790_000_000_000);
  });

  it('diferencaRtp atravessa o wrap de 32 bits', () => {
    expect(diferencaRtp(100, 4_294_967_000)).toBe(396);
    expect(diferencaRtp(4_294_967_000, 100)).toBe(-396);
  });

  it('mediana', () => {
    expect(mediana([])).toBeNull();
    expect(mediana([3, 1, 2])).toBe(2);
    expect(mediana([4, 1, 2, 3])).toBe(2.5);
  });
});
