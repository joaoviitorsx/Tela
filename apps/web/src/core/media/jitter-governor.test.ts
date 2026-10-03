import { describe, expect, it } from 'vitest';
import { JitterGovernor, PISO_ABSOLUTO_MS, pisoPeloRtt } from './jitter-governor.js';
import {
  JITTER_INICIAL_MS,
  JITTER_MAXIMO_MS,
  JITTER_MINIMO_MS,
} from '../mesh/peer-link.js';
import type { RecepcaoStats } from '../ports/media-transport.js';

/**
 * `inbound-rtp` reporta TOTAIS acumulados, não taxas. O governador trabalha
 * com o delta entre leituras, então o helper acumula como o navegador acumula.
 */
function leitura(extra: Partial<RecepcaoStats> = {}): RecepcaoStats {
  return {
    jitterBufferMs: 80,
    processamentoMs: 95,
    decodeMs: 8,
    congelamentos: 0,
    tempoCongeladoS: 0,
    quadrosDescartados: 0,
    pacotesPerdidos: 0,
    pedidosDeKeyframe: 0,
    decoder: null,
    ...extra,
  };
}

/** Alimenta N amostras limpas e devolve o último alvo emitido. */
function calmaria(g: JitterGovernor, n: number): number | null {
  let ultimo: number | null = null;
  for (let i = 0; i < n; i += 1) {
    const v = g.observe(leitura());
    if (v !== null) ultimo = v.ms;
  }
  return ultimo;
}

describe('JitterGovernor', () => {
  it('começa nos 80ms e não decide nada na primeira leitura', () => {
    const g = new JitterGovernor();
    expect(g.atual).toBe(JITTER_INICIAL_MS);
    // A primeira só tem total acumulado, não tem delta com o que comparar.
    expect(g.observe(leitura())).toBeNull();
  });

  it('não faz nada sem recepção — o transmissor não tem jitter buffer', () => {
    const g = new JitterGovernor();
    expect(g.observe(null)).toBeNull();
    expect(g.atual).toBe(JITTER_INICIAL_MS);
  });

  it('DEVOLVE latência quando a conexão prova que aguenta', () => {
    const g = new JitterGovernor();
    const depois = calmaria(g, 40);

    expect(depois).not.toBeNull();
    expect(depois!).toBeLessThan(JITTER_INICIAL_MS);
    expect(g.atual).toBeLessThan(JITTER_INICIAL_MS);
  });

  it('desce DEVAGAR — descer é aposta, não resposta', () => {
    const g = new JitterGovernor();
    // Doze amostras limpas compram exatamente um passo de 10ms.
    calmaria(g, 13);
    expect(g.atual).toBe(JITTER_INICIAL_MS - 10);
  });

  it('SOBE no primeiro congelamento, e sobe forte', () => {
    const g = new JitterGovernor();
    g.observe(leitura());
    const v = g.observe(leitura({ congelamentos: 1 }));

    expect(v).not.toBeNull();
    expect(v!.ms).toBe(JITTER_INICIAL_MS + 40);
  });

  it('sobe também com PERDA, antes de virar congelamento', () => {
    const g = new JitterGovernor();
    g.observe(leitura());
    /*
      Perda em rajada vira bloco na tela antes de virar `freezeCount`. Esperar o
      congelamento para reagir é esperar o usuário já ter visto o defeito.
    */
    const v = g.observe(leitura({ pacotesPerdidos: 12 }));
    expect(v?.ms).toBe(JITTER_INICIAL_MS + 40);
  });

  it('um congelamento apaga a calmaria acumulada', () => {
    const g = new JitterGovernor();
    calmaria(g, 10); // quase um passo de descida
    g.observe(leitura({ congelamentos: 1 }));
    const antes = g.atual;

    // As dez amostras anteriores não valem mais nada: o contador zerou.
    calmaria(g, 10);
    expect(g.atual).toBe(antes);
  });

  it('respeita o piso — abaixo dele o ganho não paga o risco', () => {
    const g = new JitterGovernor();
    calmaria(g, 500);
    expect(g.atual).toBe(JITTER_MINIMO_MS);
    // E no piso ele para de falar, em vez de repetir o mesmo valor por segundo.
    expect(calmaria(g, 50)).toBeNull();
  });

  it('respeita o teto — acima dele o produto deixa de ser tempo real', () => {
    const g = new JitterGovernor();
    let congelou = 0;
    for (let i = 0; i < 40; i += 1) {
      congelou += 1;
      g.observe(leitura({ congelamentos: congelou }));
    }
    expect(g.atual).toBe(JITTER_MAXIMO_MS);
    expect(g.observe(leitura({ congelamentos: congelou + 1 }))).toBeNull();
  });

  it('rede ruim e depois boa: sobe, segura, e só então devolve', () => {
    const g = new JitterGovernor();
    g.observe(leitura());

    // Três travadas seguidas.
    for (let i = 1; i <= 3; i += 1) g.observe(leitura({ congelamentos: i }));
    const pico = g.atual;
    expect(pico).toBe(JITTER_INICIAL_MS + 120);

    // A rede melhorou. A devolução é lenta de propósito.
    calmaria(g, 13);
    expect(g.atual).toBe(pico - 10);
  });

  it('reset volta ao início — outra transmissão, outra rede', () => {
    const g = new JitterGovernor();
    g.observe(leitura());
    g.observe(leitura({ congelamentos: 1 }));
    expect(g.atual).not.toBe(JITTER_INICIAL_MS);

    g.reset();
    expect(g.atual).toBe(JITTER_INICIAL_MS);
    expect(g.observe(leitura())).toBeNull();
  });
});

describe('piso pelo RTT (estudo 2 · T3)', () => {
  it('RTT + 25 sem perda; 2·RTT + 35 com perda; sem RTT, o piso fixo', () => {
    expect(pisoPeloRtt(40, false)).toBe(65);
    expect(pisoPeloRtt(40, true)).toBe(115);
    expect(pisoPeloRtt(0, false)).toBe(JITTER_MINIMO_MS);
    expect(pisoPeloRtt(Number.NaN, true)).toBe(JITTER_MINIMO_MS);
  });

  it('limites: nunca abaixo de 20 ms nem acima do teto', () => {
    // RTT de 1 ms já dá 26 (o NACK ainda precisa de margem); o limite de 20 é guarda.
    expect(pisoPeloRtt(1, false)).toBe(26);
    expect(pisoPeloRtt(1, false)).toBeGreaterThanOrEqual(PISO_ABSOLUTO_MS);
    expect(pisoPeloRtt(500, true)).toBe(JITTER_MAXIMO_MS);
  });

  it('rede local calma: desce abaixo dos 40 fixos, até o piso do RTT', () => {
    const g = new JitterGovernor();
    let ultimo = g.atual;
    for (let i = 0; i < 400; i += 1) ultimo = g.observe(leitura(), 3)?.ms ?? ultimo;
    expect(g.atual).toBe(pisoPeloRtt(3, false));
    expect(g.atual).toBeLessThan(JITTER_MINIMO_MS);
    expect(g.podeDescer).toBe(false);
  });

  it('RTT alto: sobe ao piso JÁ, sem esperar a travada', () => {
    const g = new JitterGovernor();
    g.observe(leitura(), 90);
    const d = g.observe(leitura(), 90);
    expect(d).toEqual({ ms: 115 });
    expect(g.atual).toBe(115);
  });

  it('um pico isolado de RTT não ergue o piso (mediana de 5)', () => {
    const g = new JitterGovernor();
    for (let i = 0; i < 4; i += 1) g.observe(leitura(), 20);
    const antes = g.atual;
    g.observe(leitura(), 180);
    expect(g.atual).toBe(antes);
  });

  it('perda com RTT alto pede o piso maior', () => {
    const g = new JitterGovernor();
    g.observe(leitura({ pacotesPerdidos: 0 }), 60);
    const d = g.observe(leitura({ pacotesPerdidos: 10 }), 60);
    expect(d).toEqual({ ms: 155 });
  });
});
