import { P2P_LIMITS } from '@tela/shared';
import { describe, expect, it } from 'vitest';
import {
  CAPACIDADE_ATE_MEDIR,
  type EntradaDeCapacidade,
  capacidadePelaBanda,
  pisoPorEspectador,
} from './capacidade-pela-banda.js';

const Mbps = (n: number) => n * 1_000_000;

function entrada(extra: Partial<EntradaDeCapacidade> = {}): EntradaDeCapacidade {
  return {
    orcamento: Mbps(18.2),
    enviadoPorCaminho: Mbps(16.17),
    caminhos: 5,
    encoderOcioso: false,
    reservaAudio: 141_000,
    prioridade: 'fluidez',
    capacidadeDaMaquina: P2P_LIMITS.maxViewers,
    atual: CAPACIDADE_ATE_MEDIR,
    ...extra,
  };
}

describe('capacidadePelaBanda (ADR 0030)', () => {
  it('o piso por espectador é o fundo da escada mais o áudio, e cai a 30fps', () => {
    const fluidez = pisoPorEspectador('fluidez', 141_000);
    expect(fluidez).toBeGreaterThan(Mbps(1.9));
    expect(fluidez).toBeLessThan(Mbps(2.2));
    expect(pisoPorEspectador('nitidez', 141_000)).toBeLessThan(fluidez);
  });

  it('sem medição fica como está, nunca abaixo de quem já está', () => {
    expect(capacidadePelaBanda(entrada({ orcamento: null, caminhos: 0 }))).toBe(CAPACIDADE_ATE_MEDIR);
    expect(capacidadePelaBanda(entrada({ orcamento: null, caminhos: 7, atual: 5 }))).toBe(7);
    expect(capacidadePelaBanda(entrada({ enviadoPorCaminho: 0 }))).toBe(CAPACIDADE_ATE_MEDIR);
  });

  it('a álgebra: ⌊b·N/p⌋, com a folga de admissão', () => {
    // Saturado: b (0,68 da fatia) é menor que 0,75 × enviado, e é ele que vale.
    const b = Mbps(10);
    const n = capacidadePelaBanda(entrada({ orcamento: b, enviadoPorCaminho: Mbps(15), caminhos: 5 }));
    const piso = pisoPorEspectador('fluidez', 141_000) * 1.1;
    expect(n).toBe(Math.floor((b * 5) / piso));
  });

  it('ADR 0018: quando somos o limitador, b mente e o que sai do link é que conta', () => {
    // Um espectador a 16 Mbps num link de 20: b = 18,2 "cabe" 8 no piso; o
    // link útil (15 Mbps) cabe 6. Vale 0,75 × enviado.
    const n = capacidadePelaBanda(entrada({ orcamento: Mbps(18.2), enviadoPorCaminho: Mbps(16.17), caminhos: 1 }));
    expect(n).toBeLessThanOrEqual(6);
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it('uma leva de entrantes não multiplica um b velho por um N novo', () => {
    // 27 caminhos num link de 100 Mbps: cada um recebe 3,7; b ainda diz 10.
    const n = capacidadePelaBanda(entrada({ orcamento: Mbps(10), enviadoPorCaminho: Mbps(3.7), caminhos: 27, atual: 27 }));
    expect(n).toBeLessThanOrEqual(33);
    expect(n).toBeGreaterThanOrEqual(27);
  });

  it('nunca expulsa: abaixo da plateia o teto é a plateia', () => {
    expect(capacidadePelaBanda(entrada({ orcamento: Mbps(0.75), enviadoPorCaminho: Mbps(1), caminhos: 20, atual: 20 }))).toBe(20);
  });

  it('nunca acima do que a máquina codifica', () => {
    expect(capacidadePelaBanda(entrada({ orcamento: Mbps(300), enviadoPorCaminho: Mbps(16), caminhos: 10, capacidadeDaMaquina: 5, atual: 5 }))).toBe(5);
    expect(capacidadePelaBanda(entrada({ orcamento: Mbps(300), enviadoPorCaminho: Mbps(16), caminhos: 10, atual: 10 }))).toBe(P2P_LIMITS.maxViewers);
  });

  it('o link farto chega ao teto em duas rodadas: cada entrante remede', () => {
    const r1 = capacidadePelaBanda(entrada({ caminhos: 5, atual: 5 }));
    expect(r1).toBeGreaterThan(20);
    const r2 = capacidadePelaBanda(entrada({ caminhos: r1, atual: r1 }));
    expect(r2).toBe(P2P_LIMITS.maxViewers);
  });

  it('histerese: meia vaga de ruído não fecha nem abre', () => {
    const piso = pisoPorEspectador('fluidez', 141_000) * 1.1;
    // Exatamente 10,4 vagas: fica em 10 (abrir exige 11).
    const b = (10.4 * piso) / 10;
    expect(capacidadePelaBanda(entrada({ orcamento: b, enviadoPorCaminho: b * 2, caminhos: 10, atual: 10 }))).toBe(10);
    // 9,6 vagas com teto 10: faltam 0,4 — menos que meia vaga, fica em 10.
    const b2 = (9.6 * piso) / 10;
    expect(capacidadePelaBanda(entrada({ orcamento: b2, enviadoPorCaminho: b2 * 2, caminhos: 10, atual: 10 }))).toBe(10);
    // 9,4 vagas: fecha para 9 — mas a plateia é 10, então 10. Com 8 na sala, 9.
    const b3 = (9.4 * piso) / 10;
    expect(capacidadePelaBanda(entrada({ orcamento: b3, enviadoPorCaminho: b3 * 2, caminhos: 10, atual: 10 }))).toBe(10);
    const b4 = (9.4 * piso) / 8;
    expect(capacidadePelaBanda(entrada({ orcamento: b4, enviadoPorCaminho: b4 * 2, caminhos: 8, atual: 10 }))).toBe(9);
  });

  it('cena parada não fecha vaga: o envio caiu, o link não', () => {
    const e = entrada({ orcamento: Mbps(18.2), enviadoPorCaminho: Mbps(1), caminhos: 5, atual: 26, encoderOcioso: true });
    expect(capacidadePelaBanda(e)).toBe(26);
    expect(capacidadePelaBanda({ ...e, encoderOcioso: false })).toBeLessThan(26);
  });
});

describe('capacidadePelaBanda — nunca fecha abaixo do teto de sempre (relato "SEM VAGA · 1/1")', () => {
  it('um amigo, cena leve (~2 Mbps enviados): continua cabendo 5', () => {
    expect(
      capacidadePelaBanda({
        orcamento: 2_500_000,
        enviadoPorCaminho: 2_000_000,
        caminhos: 1,
        encoderOcioso: false,
        reservaAudio: 141_000,
        prioridade: 'fluidez',
        capacidadeDaMaquina: 50,
        atual: 5,
      }),
    ).toBe(CAPACIDADE_ATE_MEDIR);
  });

  it('máquina que só serve 3: o chão respeita a máquina', () => {
    expect(
      capacidadePelaBanda({
        orcamento: 500_000,
        enviadoPorCaminho: 400_000,
        caminhos: 1,
        encoderOcioso: false,
        reservaAudio: 0,
        prioridade: 'fluidez',
        capacidadeDaMaquina: 3,
        atual: 3,
      }),
    ).toBe(3);
  });
});
