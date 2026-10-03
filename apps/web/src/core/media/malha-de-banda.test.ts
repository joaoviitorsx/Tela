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

describe('tela parada não é colapso (consumo do encoder, simulador --parado)', () => {
  const pausa = (consumoDoEncoder: number) => ({
    limitation: 'bandwidth' as const,
    bitrateBps: 2_000_000,
    paresMedidos: 1,
    availablePorPeer: { v_1: 2_900_000 },
    consumoDoEncoder,
  });
  const colapso = { limitation: 'bandwidth' as const, bitrateBps: 2_600_000, paresMedidos: 1, availablePorPeer: { v_1: 2_700_000 }, consumoDoEncoder: 1 };

  /** Link bom por 10 s: o orçamento se estabelece acima de 3 Mbps. */
  function aquecida(): MalhaDeBanda {
    const m = new MalhaDeBanda();
    m.semear(20_000_000);
    for (let i = 1; i <= 10; i += 1) m.observar(leitura(i));
    return m;
  }

  it('encoder a 12% do alvo: bandwidth não derruba o orçamento, nem durante nem na carência', () => {
    const m = aquecida();
    const antes = m.orcamento;
    expect(antes).toBeGreaterThan(3_000_000);
    for (let i = 11; i <= 70; i += 1) m.observar(leitura(i, { stats: pausa(0.12) }));
    // O jogo volta: consumo cheio, a estimativa ainda baixa, durante a carência.
    for (let i = 71; i <= 90; i += 1) m.observar(leitura(i, { stats: pausa(1) }));
    expect(m.orcamento).toBe(antes);
  });

  it('colapso de verdade (encoder produzindo o alvo) continua derrubando', () => {
    const m = aquecida();
    for (let i = 11; i <= 50; i += 1) m.observar(leitura(i, { stats: colapso }));
    expect(m.orcamento).toBeLessThan(3_000_000);
  });

  it('passada a carência, o colapso volta a valer', () => {
    const m = aquecida();
    for (let i = 11; i <= 20; i += 1) m.observar(leitura(i, { stats: pausa(0.12) }));
    const naPausa = m.orcamento;
    for (let i = 21; i <= 40; i += 1) m.observar(leitura(i, { stats: colapso }));
    expect(m.orcamento).toBe(naPausa);
    for (let i = 41; i <= 90; i += 1) m.observar(leitura(i, { stats: colapso }));
    expect(m.orcamento).toBeLessThan(3_000_000);
  });
});
