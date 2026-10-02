import type { PortaReal } from './porta-nativa.js';
import { MARCA_DA_PORTA_SOM } from './ponte.js';

/**
 * A `MessagePort` do PCM do "só o jogo" (Windows, D3), do lado da página: o
 * preload a entrega por `window.postMessage` com a marca de `ponte.ts`, e
 * `aguardar(id)` resolve quando a da sessão `id` chega — antes ou depois do
 * pedido, porque o main a posta ao mesmo tempo em que responde ao `invoke`.
 * Mesmo desenho de `porta-nativa.ts`.
 */
export type PortasDeSom = {
  aguardar(id: number): Promise<PortaReal>;
};

export type JanelaDePortasDeSom = {
  addEventListener(tipo: 'message', ouvinte: (e: { readonly data: unknown; readonly ports: readonly PortaReal[]; readonly source: unknown }) => void): void;
};

export function makePortasDeSom(janela: JanelaDePortasDeSom): PortasDeSom {
  const chegadas = new Map<number, PortaReal>();
  const esperas = new Map<number, (p: PortaReal) => void>();

  janela.addEventListener('message', (e) => {
    // Só a própria janela: o preload repassa as portas com
    // `window.postMessage`. Um iframe (ou qualquer outra origem que consiga
    // postar `message` aqui) não entrega porta nenhuma (S-21).
    if (e.source !== janela) return;
    const dados = e.data as { tipo?: unknown; id?: unknown } | null;
    if (typeof dados !== 'object' || dados === null || dados.tipo !== MARCA_DA_PORTA_SOM) return;
    const porta = e.ports[0];
    if (typeof dados.id !== 'number' || porta === undefined) return;
    const espera = esperas.get(dados.id);
    if (espera !== undefined) {
      esperas.delete(dados.id);
      espera(porta);
    } else {
      chegadas.set(dados.id, porta);
    }
  });

  return {
    aguardar(id) {
      const pronta = chegadas.get(id);
      if (pronta !== undefined) {
        chegadas.delete(id);
        return Promise.resolve(pronta);
      }
      return new Promise((resolver) => esperas.set(id, resolver));
    },
  };
}
