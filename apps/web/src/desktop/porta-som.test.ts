import { describe, expect, it } from 'vitest';
import { MARCA_DA_PORTA_SOM } from './ponte.js';
import type { PortaReal } from './porta-nativa.js';
import { makePortasDeSom } from './porta-som.js';

const porta = (): PortaReal => ({ postMessage: () => undefined, onmessage: null, close: () => undefined });

function janela() {
  let ouvinte: ((e: { data: unknown; ports: readonly PortaReal[] }) => void) | null = null;
  return {
    addEventListener: (_t: 'message', o: typeof ouvinte) => {
      ouvinte = o;
    },
    postar: (data: unknown, ports: readonly PortaReal[]) => ouvinte?.({ data, ports }),
  };
}

describe('makePortasDeSom', () => {
  it('resolve quando a porta da sessão chega depois do pedido', async () => {
    const j = janela();
    const portas = makePortasDeSom(j as never);
    const espera = portas.aguardar(7);
    const p = porta();
    j.postar({ tipo: MARCA_DA_PORTA_SOM, id: 7 }, [p]);
    expect(await espera).toBe(p);
  });

  it('guarda a que chegou antes do pedido', async () => {
    const j = janela();
    const portas = makePortasDeSom(j as never);
    const p = porta();
    j.postar({ tipo: MARCA_DA_PORTA_SOM, id: 3 }, [p]);
    expect(await portas.aguardar(3)).toBe(p);
  });

  it('ignora mensagens que não são da marca, sem id ou sem porta', async () => {
    const j = janela();
    const portas = makePortasDeSom(j as never);
    const espera = portas.aguardar(1);
    j.postar({ tipo: 'outra', id: 1 }, [porta()]);
    j.postar({ tipo: MARCA_DA_PORTA_SOM }, [porta()]);
    j.postar({ tipo: MARCA_DA_PORTA_SOM, id: 1 }, []);
    j.postar('texto', []);
    const p = porta();
    j.postar({ tipo: MARCA_DA_PORTA_SOM, id: 1 }, [p]);
    expect(await espera).toBe(p);
  });
});
