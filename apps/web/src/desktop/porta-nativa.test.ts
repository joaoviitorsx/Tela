import { describe, expect, it, vi } from 'vitest';
import { MARCA_DA_PORTA } from './ponte.js';
import { type JanelaDePortas, makeLigacaoNativa, type PortaReal } from './porta-nativa.js';

function janelaFalsa() {
  let ouvinte: Parameters<JanelaDePortas['addEventListener']>[1] | null = null;
  return {
    janela: { addEventListener: (_t: 'message', o: typeof ouvinte) => (ouvinte = o) } as JanelaDePortas,
    chegar: (dados: unknown, ports: PortaReal[]) => ouvinte?.({ data: dados, ports }),
  };
}

function portaFalsa() {
  const enviadas: unknown[] = [];
  const porta: PortaReal & { enviadas: unknown[]; fechada: boolean; receber: (m: unknown) => void } = {
    enviadas,
    fechada: false,
    onmessage: null,
    postMessage: (m) => enviadas.push(m),
    close: () => {
      porta.fechada = true;
    },
    receber: (m) => porta.onmessage?.({ data: m }),
  };
  return porta;
}

describe('makeLigacaoNativa', () => {
  it('a porta que chega pela janela resolve quem espera, antes ou depois', async () => {
    const { janela, chegar } = janelaFalsa();
    const ligacao = makeLigacaoNativa(janela);
    const p1 = portaFalsa();
    chegar({ tipo: MARCA_DA_PORTA, id: 1 }, [p1]);
    expect(await ligacao.aguardar(1)).toBe(p1);

    const espera = ligacao.aguardar(2);
    const p2 = portaFalsa();
    chegar({ tipo: MARCA_DA_PORTA, id: 2 }, [p2]);
    expect(await espera).toBe(p2);
  });

  it('ignora mensagens de outras marcas, sem id ou sem porta', async () => {
    const { janela, chegar } = janelaFalsa();
    const ligacao = makeLigacaoNativa(janela);
    chegar({ tipo: 'outra', id: 1 }, [portaFalsa()]);
    chegar({ tipo: MARCA_DA_PORTA }, [portaFalsa()]);
    chegar({ tipo: MARCA_DA_PORTA, id: 1 }, []);
    chegar('texto', [portaFalsa()]);
    chegar(null, [portaFalsa()]);
    const p = portaFalsa();
    chegar({ tipo: MARCA_DA_PORTA, id: 1 }, [p]);
    expect(await ligacao.aguardar(1)).toBe(p);
  });

  it('ordens antes da porta ficam guardadas e saem ao ligar; `parar` sem porta é descartado', () => {
    const ligacao = makeLigacaoNativa(janelaFalsa().janela);
    ligacao.porta.postMessage({ tipo: 'ordem', linha: 'alvo 1920 1080 60 12000000' });
    ligacao.porta.postMessage({ tipo: 'ordem', linha: 'parar' });
    ligacao.porta.postMessage({ tipo: 'ordem', linha: 'chave' });
    const real = portaFalsa();
    ligacao.ligar(1, real);
    expect(real.enviadas).toEqual([
      { tipo: 'ordem', linha: 'alvo 1920 1080 60 12000000' },
      { tipo: 'ordem', linha: 'chave' },
    ]);
    ligacao.porta.postMessage({ tipo: 'ordem', linha: 'atraso 2' });
    expect(real.enviadas).toHaveLength(3);
  });

  it('eventos antes do ouvinte ficam guardados (o `pronto`); quadros não', () => {
    const ligacao = makeLigacaoNativa(janelaFalsa().janela);
    const real = portaFalsa();
    ligacao.ligar(1, real);
    real.receber({ tipo: 'quadro', chave: true });
    real.receber({ tipo: 'captura' });
    real.receber({ tipo: 'evento', evento: { evento: 'pronto' } });
    real.receber(42); // lixo
    const recebidas = vi.fn();
    ligacao.porta.onmessage = (e) => recebidas(e.data);
    expect(recebidas.mock.calls).toEqual([[{ tipo: 'evento', evento: { evento: 'pronto' } }]]);
    real.receber({ tipo: 'quadro', chave: false });
    expect(recebidas).toHaveBeenCalledTimes(2);
    expect(ligacao.porta.onmessage).not.toBeNull();
    ligacao.porta.onmessage = null;
    real.receber({ tipo: 'evento', evento: { evento: 'stats' } });
    expect(recebidas).toHaveBeenCalledTimes(2);
  });

  it('religar fecha a anterior e mensagens atrasadas dela não passam', () => {
    const ligacao = makeLigacaoNativa(janelaFalsa().janela);
    const recebidas = vi.fn();
    ligacao.porta.onmessage = (e) => recebidas(e.data);
    const p1 = portaFalsa();
    const p2 = portaFalsa();
    ligacao.ligar(1, p1);
    ligacao.ligar(2, p2);
    expect(p1.fechada).toBe(true);
    p1.receber({ tipo: 'captura' });
    p2.receber({ tipo: 'captura' });
    expect(recebidas).toHaveBeenCalledTimes(1);
    ligacao.porta.postMessage({ tipo: 'ordem', linha: 'chave' });
    expect(p2.enviadas).toEqual([{ tipo: 'ordem', linha: 'chave' }]);
    expect(p1.enviadas).toEqual([]);
  });

  it('desligar só mexe na porta da sessão certa', () => {
    const ligacao = makeLigacaoNativa(janelaFalsa().janela);
    const p2 = portaFalsa();
    ligacao.ligar(2, p2);
    ligacao.desligar(1);
    expect(p2.fechada).toBe(false);
    ligacao.desligar(2);
    expect(p2.fechada).toBe(true);
    ligacao.porta.postMessage({ tipo: 'ordem', linha: 'chave' });
    expect(p2.enviadas).toEqual([]);
  });
});
