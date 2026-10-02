import { describe, expect, it } from 'vitest';
import type { RecepcaoStats } from '../ports/media-transport.js';
import { AMOSTRAS_PARA_AVISAR, AMOSTRAS_PARA_LIMPAR, VigiaDeFluidez } from './vigia-de-fluidez.js';

const base: RecepcaoStats = {
  jitterBufferMs: 40,
  processamentoMs: 50,
  decodeMs: 4,
  congelamentos: 0,
  tempoCongeladoS: 0,
  quadrosDescartados: 0,
  pacotesPerdidos: 0,
  pedidosDeKeyframe: 0,
  decoder: null,
};

/** Alimenta `n` leituras de 1 s, cada uma somando `delta` aos acumulados. */
function rodar(
  vigia: VigiaDeFluidez,
  n: number,
  delta: Partial<Pick<RecepcaoStats, 'pacotesPerdidos' | 'congelamentos' | 'quadrosDescartados'>>,
  opcoes: { fps?: number; decodeMs?: number; desde?: { t: number; r: RecepcaoStats } } = {},
) {
  let t = opcoes.desde?.t ?? 0;
  let r = opcoes.desde?.r ?? base;
  // Continuando uma sequência, a última leitura já foi vista: não relê.
  let causa = opcoes.desde === undefined ? vigia.observar(r, opcoes.fps ?? 60, t) : null;
  for (let i = 0; i < n; i += 1) {
    t += 1000;
    r = {
      ...r,
      pacotesPerdidos: r.pacotesPerdidos + (delta.pacotesPerdidos ?? 0),
      congelamentos: r.congelamentos + (delta.congelamentos ?? 0),
      quadrosDescartados: r.quadrosDescartados + (delta.quadrosDescartados ?? 0),
      decodeMs: opcoes.decodeMs ?? r.decodeMs,
    };
    causa = vigia.observar(r, opcoes.fps ?? 60, t);
  }
  return { causa, t, r };
}

describe('VigiaDeFluidez', () => {
  it('recepção limpa: nada', () => {
    expect(rodar(new VigiaDeFluidez(), 20, {}).causa).toBeNull();
  });

  it('fps baixo sem perda nem descarte não acusa ninguém (tela parada ou quem transmite)', () => {
    expect(rodar(new VigiaDeFluidez(), 20, {}, { fps: 8 }).causa).toBeNull();
  });

  it('perda sustentada vira "rede" só depois de várias leituras', () => {
    const v = new VigiaDeFluidez();
    expect(rodar(v, AMOSTRAS_PARA_AVISAR - 1, { pacotesPerdidos: 20 }).causa).toBeNull();
    const v2 = new VigiaDeFluidez();
    expect(rodar(v2, AMOSTRAS_PARA_AVISAR, { pacotesPerdidos: 20 }).causa).toBe('rede');
  });

  it('congelar também é "rede"', () => {
    expect(rodar(new VigiaDeFluidez(), AMOSTRAS_PARA_AVISAR, { congelamentos: 1 }).causa).toBe('rede');
  });

  it('decoder jogando quadro fora é "decodificacao", mesmo congelando junto', () => {
    expect(
      rodar(new VigiaDeFluidez(), AMOSTRAS_PARA_AVISAR, { quadrosDescartados: 15, congelamentos: 1 }, { fps: 40 }).causa,
    ).toBe('decodificacao');
  });

  it('decode mais lento que o intervalo entre quadros é "decodificacao"', () => {
    expect(rodar(new VigiaDeFluidez(), AMOSTRAS_PARA_AVISAR, {}, { fps: 60, decodeMs: 20 }).causa).toBe('decodificacao');
  });

  it('o aviso não pisca: só some depois de várias leituras limpas', () => {
    const v = new VigiaDeFluidez();
    const ruim = rodar(v, AMOSTRAS_PARA_AVISAR, { pacotesPerdidos: 20 });
    expect(ruim.causa).toBe('rede');
    const quase = rodar(v, AMOSTRAS_PARA_LIMPAR - 1, {}, { desde: ruim });
    expect(quase.causa).toBe('rede');
    expect(rodar(v, 1, {}, { desde: quase }).causa).toBeNull();
  });

  it('contadores que voltam (conexão refeita) viram nova base, sem acusar', () => {
    const v = new VigiaDeFluidez();
    rodar(v, 3, { pacotesPerdidos: 20 });
    expect(v.observar(base, 60, 10_000)).toBeNull();
  });
});
