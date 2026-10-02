import { describe, expect, it, vi } from 'vitest';
import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { CodificadorComutavel, type CodificadorMinimo } from './codificador-comutavel.js';

const ALVO = { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 } as unknown as AlvoDoCodificador;
const OUTRO = { width: 1280, height: 720, fps: 60, bitrate: 5_000_000 } as unknown as AlvoDoCodificador;

type Falso = CodificadorMinimo & { readonly nome: string; readonly chamadas: string[] };

function falso(nome: string): Falso {
  const chamadas: string[] = [];
  return {
    nome,
    chamadas,
    iniciar: async (_t, a) => void chamadas.push(`iniciar ${a.width}`),
    configurar: (a) => void chamadas.push(`configurar ${a.width}`),
    trocarFonte: () => void chamadas.push('trocarFonte'),
    pedirChave: (m, s) => void chamadas.push(`chave ${m ?? '-'} ${s ?? '-'}`),
    definirAtraso: (q) => void chamadas.push(`atraso ${q}`),
    estatisticas: () => ({ implementacao: nome }),
    fonte: () => (nome.startsWith('nativo') ? { width: 2560, height: 1440 } : null),
    parar: () => void chamadas.push('parar'),
  };
}

function montar() {
  const criados: Falso[] = [];
  let n = 0;
  const nativas = new Set<MediaStreamTrack>();
  const comutavel = new CodificadorComutavel<Falso>({
    nativo: () => {
      const c = falso(`nativo${n++}`);
      criados.push(c);
      return c;
    },
    webcodecs: () => {
      const c = falso(`webcodecs${n++}`);
      criados.push(c);
      return c;
    },
    ehNativa: (t) => nativas.has(t),
  });
  const trilhaNativa = { id: 'fantasma' } as unknown as MediaStreamTrack;
  const trilhaReal = { id: 'real' } as unknown as MediaStreamTrack;
  nativas.add(trilhaNativa);
  return { comutavel, criados, trilhaNativa, trilhaReal };
}

describe('CodificadorComutavel', () => {
  it('nasce com o externo escutando, e iniciar com a trilha-fantasma fica nele', async () => {
    const { comutavel, criados, trilhaNativa } = montar();
    expect(criados.map((c) => c.nome)).toEqual(['nativo0']);
    expect(comutavel.caminhoAtual).toBe('nativo');
    await comutavel.iniciar(trilhaNativa, ALVO);
    expect(criados).toHaveLength(1);
    expect(criados[0]!.chamadas).toEqual(['iniciar 1920']);
    expect(comutavel.estatisticas()).toEqual({ implementacao: 'nativo0' });
    expect(comutavel.fonte()).toEqual({ width: 2560, height: 1440 });
  });

  it('iniciar com uma captura real para o externo e usa o WebCodecs', async () => {
    const { comutavel, criados, trilhaReal } = montar();
    comutavel.definirAtraso(2);
    await comutavel.iniciar(trilhaReal, ALVO);
    expect(comutavel.caminhoAtual).toBe('webcodecs');
    expect(criados.map((c) => c.nome)).toEqual(['nativo0', 'webcodecs1']);
    expect(criados[0]!.chamadas).toEqual(['atraso 2', 'parar']);
    // O atraso que o worker já tinha pedido vale para quem entrou.
    expect(criados[1]!.chamadas).toEqual(['iniciar 1920', 'atraso 2']);
    expect(comutavel.fonte()).toBeNull();
  });

  it('o resto é repasse: configurar, chave com plateia, atraso, parar', async () => {
    const { comutavel, criados, trilhaNativa } = montar();
    await comutavel.iniciar(trilhaNativa, ALVO);
    comutavel.configurar(OUTRO);
    comutavel.pedirChave('pli', 3);
    comutavel.pedirChave();
    comutavel.definirAtraso(1);
    comutavel.trocarFonte(trilhaNativa);
    comutavel.parar();
    expect(criados[0]!.chamadas).toEqual([
      'iniciar 1920',
      'configurar 1280',
      'chave pli 3',
      'chave - -',
      'atraso 1',
      'trocarFonte',
      'parar',
    ]);
  });

  it('trocar de fonte para outro caminho reinicia no alvo corrente', async () => {
    const { comutavel, criados, trilhaNativa, trilhaReal } = montar();
    await comutavel.iniciar(trilhaNativa, ALVO);
    comutavel.configurar(OUTRO);
    comutavel.definirAtraso(3);
    comutavel.trocarFonte(trilhaReal);
    await Promise.resolve();
    expect(comutavel.caminhoAtual).toBe('webcodecs');
    expect(criados[0]!.chamadas.at(-1)).toBe('parar');
    expect(criados[1]!.chamadas).toEqual(['iniciar 1280', 'atraso 3']);

    // E de volta: o nativo renasce, porque o anterior já parou.
    comutavel.trocarFonte(trilhaNativa);
    await Promise.resolve();
    expect(comutavel.caminhoAtual).toBe('nativo');
    expect(criados.map((c) => c.nome)).toEqual(['nativo0', 'webcodecs1', 'nativo2']);
    expect(criados[2]!.chamadas).toEqual(['iniciar 1280', 'atraso 3']);
  });

  it('trocar de fonte antes de iniciar é só repasse', () => {
    const { comutavel, criados, trilhaReal } = montar();
    comutavel.trocarFonte(trilhaReal);
    expect(criados).toHaveLength(1);
    expect(criados[0]!.chamadas).toEqual(['trocarFonte']);
  });

  it('as estatísticas são as de quem está no ar', async () => {
    const { comutavel, trilhaReal } = montar();
    const spy = vi.fn();
    await comutavel.iniciar(trilhaReal, ALVO);
    spy(comutavel.estatisticas());
    expect(spy).toHaveBeenCalledWith({ implementacao: 'webcodecs1' });
  });
});
