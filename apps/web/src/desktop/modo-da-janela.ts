import type { ModoDaJanela, PonteDesktop } from './ponte.js';

/**
 * O modo da janela (normal ou compacto) como estado fora do React, no mesmo
 * molde da visibilidade: a moldura lê com `useSyncExternalStore` e a fonte de
 * visibilidade também consulta (compacto = a interface grande está oculta).
 * Quem DECIDE é o main; isto só espelha o que ele diz e transmite pedidos.
 */
export type ModoDaJanelaStore = {
  readonly atual: () => ModoDaJanela;
  readonly assinar: (ouvinte: () => void) => () => void;
  readonly pedir: (modo: ModoDaJanela) => void;
};

export function criarModoDaJanela(ponte: Pick<PonteDesktop, 'aoMudarModo' | 'pedirModo'>): ModoDaJanelaStore {
  let modo: ModoDaJanela = 'normal';
  const ouvintes = new Set<() => void>();
  // Vive o tempo do app: a janela é uma só, e a assinatura não precisa sair.
  ponte.aoMudarModo((novo) => {
    if (novo === modo) return;
    modo = novo;
    for (const o of [...ouvintes]) o();
  });
  return {
    atual: () => modo,
    assinar: (ouvinte) => {
      ouvintes.add(ouvinte);
      return () => {
        ouvintes.delete(ouvinte);
      };
    },
    pedir: (pedido) => ponte.pedirModo(pedido),
  };
}
