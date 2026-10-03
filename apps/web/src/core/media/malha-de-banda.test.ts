import { describe, expect, it } from 'vitest';
import { MalhaDeBanda, orcamentoDeVideo, type DecisaoDaMalha, type LeituraDaMalha } from './malha-de-banda.js';
import { PRESET_IDS, type PresetId } from './presets.js';

/**
 * A malha isolada (TELA-026). O comportamento já é coberto pela sessão e
 * pelo simulador; aqui fica o contrato do módulo: leitura entra, decisão sai,
 * e nada acontece sem evidência.
 */
function leitura(amostra: number, extra: Partial<LeituraDaMalha> = {}): LeituraDaMalha {
  return {
    stats: { limitation: 'none', bitrateBps: 8_000_000, paresMedidos: 1, availablePorPeer: { v_1: 30_000_000 } },
    presetEfetivo: 'p1080p60',
    presetEscolhido: 'p1080p60',
    presetPorBanda: null,
    prioridade: 'fluidez',
    reservaAudio: 0,
    amostra,
    ...extra,
  };
}

describe('MalhaDeBanda', () => {
  it('o vídeo fica com o orçamento menos a reserva do áudio, nunca abaixo do piso', () => {
    expect(orcamentoDeVideo(5_000_000, 141_000)).toBe(4_859_000);
    expect(orcamentoDeVideo(200_000, 141_000)).toBe(300_000);
  });

  it('sem medição não há orçamento nem decisão', () => {
    const m = new MalhaDeBanda();
    expect(m.orcamento).toBeNull();
    expect(m.observar(leitura(1, { stats: { limitation: 'none', bitrateBps: 0, paresMedidos: 0, availablePorPeer: {} } }))).toBeNull();
  });

  it('colapso sustentado desce o orçamento e traduz em degrau menor', () => {
    const m = new MalhaDeBanda();
    m.semear(20_000_000);
    let presetPorBanda: PresetId | null = null;
    let ultima: DecisaoDaMalha | null = null;
    for (let i = 1; i <= 40; i += 1) {
      const d = m.observar(leitura(i, {
        stats: { limitation: 'bandwidth', bitrateBps: 2_600_000, paresMedidos: 1, availablePorPeer: { v_1: 2_700_000 } },
        presetPorBanda,
      }));
      if (d !== null) {
        ultima = d;
        presetPorBanda = d.presetPorBanda;
      }
    }
    expect(ultima).not.toBeNull();
    expect(ultima!.orcamentoVideo).toBeLessThan(3_000_000);
    expect(PRESET_IDS.indexOf(ultima!.presetPorBanda)).toBeGreaterThan(PRESET_IDS.indexOf('p1080p60'));
  });

  it('reiniciar esquece o orçamento', () => {
    const m = new MalhaDeBanda();
    m.semear(10_000_000);
    m.reiniciar();
    expect(m.orcamento).toBeNull();
    expect(m.estimativa).toBeNull();
  });
});

describe('o que prova colapso (ADR 0033)', () => {
  const freada = (extra: { consumoDoEncoder?: number; avail?: number; rttMs?: number } = {}) => ({
    limitation: 'bandwidth' as const,
    bitrateBps: 2_000_000,
    paresMedidos: 1,
    availablePorPeer: { v_1: extra.avail ?? 2_900_000 },
    rttMs: extra.rttMs ?? 20,
    ...(extra.consumoDoEncoder === undefined ? {} : { consumoDoEncoder: extra.consumoDoEncoder }),
  });

  /** Link bom por 10 s: o orçamento se estabelece acima de 3 Mbps. */
  function aquecida(): MalhaDeBanda {
    const m = new MalhaDeBanda();
    m.semear(20_000_000);
    for (let i = 1; i <= 10; i += 1) m.observar(leitura(i, { stats: { ...leitura(i).stats, rttMs: 20 } }));
    return m;
  }

  it('tela parada: encoder sem encher o alvo (0,78) e sem congestão — o orçamento fica', () => {
    const m = aquecida();
    const antes = m.orcamento;
    expect(antes).toBeGreaterThan(3_000_000);
    for (let i = 11; i <= 70; i += 1) m.observar(leitura(i, { stats: freada({ consumoDoEncoder: 0.78 }) }));
    expect(m.orcamento).toBe(antes);
  });

  it('rampa depois da pausa: estimativa subindo não é colapso', () => {
    const m = aquecida();
    const antes = m.orcamento;
    // A pausa vem antes (a estimativa decai a 2,9 Mbps), depois o jogo volta e ela reabre.
    for (let i = 11; i <= 20; i += 1) m.observar(leitura(i, { stats: freada({ consumoDoEncoder: 0.78 }) }));
    let avail = 2_900_000;
    for (let i = 21; i <= 50; i += 1) {
      avail *= 1.08;
      m.observar(leitura(i, { stats: freada({ consumoDoEncoder: 1, avail }) }));
    }
    expect(m.orcamento).toBe(antes);
  });

  it('colapso clássico: encoder enchendo o alvo e a estimativa parada — derruba', () => {
    const m = aquecida();
    for (let i = 11; i <= 50; i += 1) m.observar(leitura(i, { stats: freada({ consumoDoEncoder: 1, avail: 2_700_000 }) }));
    expect(m.orcamento).toBeLessThan(3_000_000);
  });

  it('conteúdo leve com congestão (RTT subiu): também derruba', () => {
    const m = aquecida();
    for (let i = 11; i <= 50; i += 1) m.observar(leitura(i, { stats: freada({ consumoDoEncoder: 0.6, avail: 2_700_000, rttMs: 140 }) }));
    expect(m.orcamento).toBeLessThan(3_000_000);
  });

  it('fora do "um encode" (sem consumo): o comportamento antigo', () => {
    const m = aquecida();
    for (let i = 11; i <= 50; i += 1) m.observar(leitura(i, { stats: freada({ avail: 2_700_000 }) }));
    expect(m.orcamento).toBeLessThan(3_000_000);
  });
});
