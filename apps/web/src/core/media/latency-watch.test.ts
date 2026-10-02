import { describe, expect, it } from 'vitest';
import { LATENCIA_LIMITE_MS, LatencyWatch } from './latency-watch.js';
import type { AmostraLatencia } from '../ports/frame-timing.js';

const amostra = (ms: number): AmostraLatencia => ({ ms, origem: 'captura' });

/** Alimenta até a média móvel convergir para perto do valor. */
const convergir = (w: LatencyWatch, ms: number, n = 80) => {
  for (let i = 0; i < n; i += 1) w.registrar(amostra(ms));
};

describe('LatencyWatch', () => {
  it('não sabe nada antes da primeira medida', () => {
    const w = new LatencyWatch();
    expect(w.estado.ms).toBeNull();
    expect(w.estado.alta).toBe(false);
    expect(w.deveReconectar(false)).toBe(false);
  });

  it('ignora medida absurda — é relógio fora de sincronia, não atraso', () => {
    const w = new LatencyWatch();
    for (const ruim of [-1, Number.NaN, Number.POSITIVE_INFINITY, 60_000]) {
      w.registrar({ ms: ruim, origem: 'captura' });
    }
    expect(w.estado.ms).toBeNull();
  });

  it('suaviza: um quadro atrasado não vira crise', () => {
    const w = new LatencyWatch();
    convergir(w, 120);
    w.registrar(amostra(3_000));
    // Com peso de 0,15 o pico move a média, mas não a joga acima do limite.
    expect(w.estado.alta).toBe(false);
  });

  it('marca como alta quando passa do limite de forma sustentada', () => {
    const w = new LatencyWatch();
    convergir(w, 900);
    expect(w.estado.ms).toBeGreaterThan(LATENCIA_LIMITE_MS);
    expect(w.estado.alta).toBe(true);
  });

  it('NÃO reconecta enquanto o ajuste barato ainda tem para onde ir', () => {
    const w = new LatencyWatch();
    convergir(w, 900);
    /*
      Reconectar custa alguns segundos de imagem. Enquanto o governador de
      jitter puder devolver buffer, a resposta certa é devolver — este vigia é
      o último recurso, não o primeiro.
    */
    for (let i = 0; i < 50; i += 1) expect(w.deveReconectar(true)).toBe(false);
  });

  it('reconecta quando o ajuste se esgotou E a latência não desceu', () => {
    const w = new LatencyWatch();
    convergir(w, 900);

    let agiu = false;
    for (let i = 0; i < 20; i += 1) {
      if (w.deveReconectar(false)) agiu = true;
    }
    expect(agiu).toBe(true);
  });

  it('exige que seja SUSTENTADO — um tique alto não basta', () => {
    const w = new LatencyWatch();
    convergir(w, 900);
    expect(w.deveReconectar(false)).toBe(false);
  });

  it('a latência voltando ao normal apaga a contagem', () => {
    const w = new LatencyWatch();
    convergir(w, 900);
    for (let i = 0; i < 5; i += 1) w.deveReconectar(false);

    // Melhorou.
    convergir(w, 120);
    expect(w.deveReconectar(false)).toBe(false);

    // E piorou de novo: a contagem recomeça do zero.
    convergir(w, 900);
    expect(w.deveReconectar(false)).toBe(false);
  });

  it('age UMA vez por sessão — se não resolveu, não era o buffer', () => {
    const w = new LatencyWatch();
    convergir(w, 900);
    let vezes = 0;
    for (let i = 0; i < 200; i += 1) {
      if (w.deveReconectar(false)) vezes += 1;
    }
    /*
      Reconectar de novo só troca uma transmissão ruim por nenhuma. Se a
      latência continua alta depois da primeira, a causa está em outro lugar.
    */
    expect(vezes).toBe(1);
  });

  it('reset devolve o direito de agir — outra sessão, outra rede', () => {
    const w = new LatencyWatch();
    convergir(w, 900);
    for (let i = 0; i < 20; i += 1) w.deveReconectar(false);

    w.reset();
    expect(w.estado.ms).toBeNull();
    convergir(w, 900);
    let agiu = false;
    for (let i = 0; i < 20; i += 1) if (w.deveReconectar(false)) agiu = true;
    expect(agiu).toBe(true);
  });

  it('a origem viaja junto — parcial não pode passar por completa', () => {
    const w = new LatencyWatch();
    w.registrar({ ms: 200, origem: 'recepcao' });
    expect(w.estado.origem).toBe('recepcao');
  });
});

describe('LatencyWatch — janela de exibição', () => {
  it('registrarJanela alimenta mediana/p95 sem mexer no vigia', () => {
    const w = new LatencyWatch();
    for (let i = 0; i < 40; i += 1) w.registrarJanela({ ms: 45, origem: 'captura' });
    expect(w.estado.janela).toMatchObject({ mediana: 45, origem: 'captura' });
    expect(w.estado.ms).toBeNull();
    expect(w.deveReconectar(false)).toBe(false);
  });

  it('esquecerMedida limpa a janela (outra conexão, outra linha do tempo)', () => {
    const w = new LatencyWatch();
    w.registrarJanela({ ms: 45, origem: 'captura' });
    w.esquecerMedida();
    expect(w.estado.janela).toBeNull();
  });
});

