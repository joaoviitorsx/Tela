import { describe, expect, it } from 'vitest';
import { AQUECIMENTO_POR_CAMINHO } from '../media/uplink-governor.js';
import {
  LEITURAS_DE_AQUECIMENTO,
  PERIODO_MAXIMO,
  PEERS_SEM_RODIZIO,
  PIORES_CAMINHOS,
  RodizioDeLeitura,
  periodoDoRodizio,
} from './rodizio-de-leitura.js';
import { statsReport } from './testing.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `v_${i}`);

/** Leitura de um caminho assentado: par nominado com estimativa. */
const saudavel = (banda = 50_000_000) =>
  statsReport([
    { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'none' },
    { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: banda },
  ]);

/** Lê o que foi escolhido e registra, como `collectStats` faz. */
function tique(r: RodizioDeLeitura, vivos: readonly string[], leitura: (id: string) => RTCStatsReport) {
  const lidos = r.escolher(vivos);
  for (const id of lidos) r.registrar(id, leitura(id));
  return lidos;
}

describe('RodizioDeLeitura (B2)', () => {
  it('o aquecimento duplicado em core/mesh é o mesmo do governador', () => {
    expect(LEITURAS_DE_AQUECIMENTO).toBe(AQUECIMENTO_POR_CAMINHO);
  });

  it('período: desligado até 5 peers e crescente com N, com teto', () => {
    for (let n = 1; n <= PEERS_SEM_RODIZIO; n += 1) expect(periodoDoRodizio(n)).toBe(1);
    expect(periodoDoRodizio(6)).toBe(2);
    expect(periodoDoRodizio(20)).toBe(4);
    expect(periodoDoRodizio(50)).toBe(PERIODO_MAXIMO);
    expect(periodoDoRodizio(500)).toBe(PERIODO_MAXIMO);
  });

  it('até 5 peers lê todo mundo em todo tique', () => {
    const r = new RodizioDeLeitura();
    for (let t = 0; t < 30; t += 1) expect(tique(r, ids(5), () => saudavel()).size).toBe(5);
  });

  it('com 50 peers assentados lê muito menos que 50 e ninguém espera mais que R tiques', () => {
    const r = new RodizioDeLeitura();
    const vivos = ids(50);
    // Aquecimento: todos lidos até assentar.
    for (let t = 0; t < LEITURAS_DE_AQUECIMENTO + 1; t += 1) tique(r, vivos, () => saudavel());
    const ultima = new Map<string, number>(vivos.map((id) => [id, 0]));
    let total = 0;
    let maiorEspera = 0;
    for (let t = 1; t <= 60; t += 1) {
      const lidos = tique(r, vivos, (id) => saudavel(1_000_000 * (1 + Number(id.slice(2)))));
      total += lidos.size;
      for (const id of lidos) ultima.set(id, t);
      for (const id of vivos) maiorEspera = Math.max(maiorEspera, t - (ultima.get(id) ?? 0));
    }
    // Orçamento: cota ⌈50/6⌉ = 9, mais os piores caminhos — longe dos 50.
    expect(total / 60).toBeLessThanOrEqual(Math.ceil(50 / PERIODO_MAXIMO) + PIORES_CAMINHOS);
    expect(maiorEspera).toBeLessThanOrEqual(PERIODO_MAXIMO);
  });

  it('quem está no aquecimento é lido todo tique, contado em LEITURAS (relatório vazio não gasta)', () => {
    const r = new RodizioDeLeitura();
    const vivos = ids(20);
    // Um peer que ainda conecta devolve relatório sem par: continua em aquecimento para sempre.
    const leitura = (id: string) => (id === 'v_7' ? statsReport([]) : saudavel());
    for (let t = 0; t < 40; t += 1) {
      const lidos = tique(r, vivos, leitura);
      expect(lidos.has('v_7')).toBe(true);
    }
  });

  it('peer que mostrou limitação ou perda é lido todo tique', () => {
    const r = new RodizioDeLeitura();
    const vivos = ids(30);
    const limitado = statsReport([
      { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'bandwidth' },
      { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 90_000_000 },
    ]);
    const perdendo = statsReport([
      { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.05 },
      { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 90_000_000 },
    ]);
    const leitura = (id: string) => (id === 'v_3' ? limitado : id === 'v_9' ? perdendo : saudavel(40_000_000));
    for (let t = 0; t < 30; t += 1) {
      const lidos = tique(r, vivos, leitura);
      if (t > LEITURAS_DE_AQUECIMENTO + 1) {
        expect(lidos.has('v_3')).toBe(true);
        expect(lidos.has('v_9')).toBe(true);
      }
    }
  });

  it('os piores caminhos pela estimativa nunca esperam a vez', () => {
    const r = new RodizioDeLeitura();
    const vivos = ids(40);
    const leitura = (id: string) => saudavel(id === 'v_20' ? 2_000_000 : 80_000_000);
    for (let t = 0; t < 40; t += 1) {
      const lidos = tique(r, vivos, leitura);
      if (t > LEITURAS_DE_AQUECIMENTO + 1) expect(lidos.has('v_20')).toBe(true);
    }
  });

  it('peer novo no meio do rodízio entra lido; peer que sai é esquecido', () => {
    const r = new RodizioDeLeitura();
    let vivos = ids(30);
    for (let t = 0; t < 20; t += 1) tique(r, vivos, () => saudavel());
    vivos = [...vivos, 'v_novo'];
    expect(tique(r, vivos, () => saudavel()).has('v_novo')).toBe(true);
    vivos = vivos.filter((id) => id !== 'v_novo');
    tique(r, vivos, () => saudavel());
    // Voltar com o mesmo id é um peer novo: sem herança de leituras.
    expect(tique(r, [...vivos, 'v_novo'], () => saudavel()).has('v_novo')).toBe(true);
  });
});
