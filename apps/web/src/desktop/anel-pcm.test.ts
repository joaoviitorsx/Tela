import { describe, expect, it } from 'vitest';
import { AJUSTE_MAXIMO_DA_TAXA, AnelPcm } from './anel-pcm.js';

const TAXA = 48_000;
const ALVO = 2880; // 60 ms

/** `n` quadros estéreo intercalados: L = rampa, R = -rampa, para conferir os canais. */
function quadros(n: number, inicio = 0): Float32Array {
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    a[2 * i] = (inicio + i) / 1_000_000;
    a[2 * i + 1] = -(inicio + i) / 1_000_000;
  }
  return a;
}

const novo = () => new AnelPcm({ capacidade: TAXA, alvo: ALVO });

describe('AnelPcm: partida', () => {
  it('só toca depois de juntar o alvo; antes é silêncio', () => {
    const anel = novo();
    anel.empurrar(quadros(ALVO - 1));
    const esq = new Float32Array(128).fill(9);
    const dir = new Float32Array(128).fill(9);
    anel.puxar(esq, dir);
    expect([...esq, ...dir].every((x) => x === 0)).toBe(true);
    anel.empurrar(quadros(1, ALVO - 1));
    anel.puxar(esq, dir);
    expect(esq[1]).toBeGreaterThan(0);
  });

  it('preserva os canais: L e R não se misturam', () => {
    const anel = novo();
    anel.empurrar(quadros(ALVO + 1000));
    const esq = new Float32Array(100);
    const dir = new Float32Array(100);
    anel.puxar(esq, dir);
    for (let i = 1; i < 100; i++) {
      expect(esq[i]).toBeGreaterThan(0);
      expect(dir[i]).toBeCloseTo(-(esq[i] ?? 0), 9);
    }
  });

  it('com o nível no alvo a leitura é fiel (taxa 1), sem rampa nem salto', () => {
    const anel = novo();
    anel.empurrar(quadros(ALVO + 480));
    const esq = new Float32Array(480);
    anel.puxar(esq, new Float32Array(480));
    // Nível acima do alvo por 480: ajuste mínimo; ainda assim monotônico e sem saltos.
    for (let i = 1; i < 480; i++) {
      const passo = (esq[i] ?? 0) - (esq[i - 1] ?? 0);
      expect(passo).toBeGreaterThan(0.9e-6);
      expect(passo).toBeLessThan(1.1e-6);
    }
  });
});

describe('AnelPcm: esvaziar', () => {
  it('esvaziou: silêncio, e só volta a tocar depois de reencher o alvo (um estalo só)', () => {
    const anel = novo();
    anel.empurrar(quadros(ALVO + 100));
    const esq = new Float32Array(480);
    const dir = new Float32Array(480);
    for (let i = 0; i < 8; i++) anel.puxar(esq, dir); // consome tudo e mais
    expect(anel.estatisticas().vazios).toBe(1);
    // Chegou pouco: ainda enchendo, silêncio.
    anel.empurrar(quadros(480, 10_000));
    anel.puxar(esq, dir);
    expect(esq.every((x) => x === 0)).toBe(true);
    // Chegou o resto do alvo: volta.
    anel.empurrar(quadros(ALVO, 20_000));
    anel.puxar(esq, dir);
    expect(esq.some((x) => x > 0)).toBe(true);
    expect(anel.estatisticas().vazios).toBe(1);
  });

  it('o silêncio entra no fim do bloco, não o apaga inteiro', () => {
    const anel = novo();
    anel.empurrar(quadros(ALVO + 10));
    // 2890 quadros; a leitura de 4096 usa 2889 e zera o resto.
    const esq = new Float32Array(4096);
    anel.puxar(esq, new Float32Array(4096));
    expect(esq[2000]).toBeGreaterThan(0);
    expect(esq[4000]).toBe(0);
  });
});

describe('AnelPcm: estouro', () => {
  it('passou do teto: descarta o velho e volta ao alvo', () => {
    const anel = novo();
    anel.empurrar(quadros(ALVO * 4));
    expect(anel.nivel()).toBe(ALVO);
    expect(anel.estatisticas().descartes).toBe(1);
    // O que sobra é o mais NOVO: a leitura recomeça perto do fim.
    const esq = new Float32Array(10);
    anel.puxar(esq, new Float32Array(10));
    expect(esq[0]).toBeGreaterThanOrEqual((ALVO * 3) / 1_000_000 - 1e-6);
  });
});

describe('AnelPcm: deriva de relógio', () => {
  /**
   * Produtor e consumidor em relógios diferentes: o produtor entrega
   * `ppm` partes por milhão a mais por segundo. Simula `segundos` de jogo em
   * passos de 10 ms (produtor) e 128 quadros (consumidor), e devolve o nível
   * mínimo e máximo depois da estabilização.
   */
  function simular(ppm: number, segundos: number) {
    const anel = novo();
    anel.empurrar(quadros(ALVO));
    const esq = new Float32Array(128);
    const dir = new Float32Array(128);
    let produzido = 0;
    let consumido = 0;
    let minimo = Infinity;
    let maximo = -Infinity;
    const total = TAXA * segundos;
    while (consumido < total) {
      // Produz o que o relógio do produtor já "gerou".
      const devido = Math.floor((consumido * (1 + ppm / 1e6)) / 480) * 480;
      while (produzido < devido) {
        anel.empurrar(quadros(480, produzido));
        produzido += 480;
      }
      anel.puxar(esq, dir);
      consumido += 128;
      if (consumido > TAXA * 5) {
        minimo = Math.min(minimo, anel.nivel());
        maximo = Math.max(maximo, anel.nivel());
      }
    }
    return { minimo, maximo, ...anel.estatisticas() };
  }

  it.each([0, 300, -300, 2000, -2000])('%i ppm: o nível fica limitado e nunca esvazia nem estoura em 5 min', (ppm) => {
    const r = simular(ppm, 300);
    expect(r.vazios).toBe(0);
    expect(r.descartes).toBe(0);
    expect(r.minimo).toBeGreaterThan(ALVO * 0.5);
    expect(r.maximo).toBeLessThan(ALVO * 2);
  });

  it('o ajuste de taxa nunca passa de 0,5%', () => {
    expect(AJUSTE_MAXIMO_DA_TAXA).toBe(0.005);
  });
});

describe('AnelPcm: validação', () => {
  it('recusa configuração impossível', () => {
    expect(() => new AnelPcm({ capacidade: 100, alvo: 0 })).toThrow(RangeError);
    expect(() => new AnelPcm({ capacidade: 100, alvo: 99 })).toThrow(RangeError);
  });

  it('um float sobrando no fim é ignorado', () => {
    const anel = novo();
    anel.empurrar(new Float32Array(2 * ALVO + 1));
    expect(anel.nivel()).toBe(ALVO);
  });
});
