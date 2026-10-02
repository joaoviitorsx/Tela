import { useCallback, useSyncExternalStore } from 'react';

/**
 * Se o painel DIAGNÓSTICO está aberto (D-04).
 *
 * Na web o botão mora no cabeçalho de cada página, e a página dona dele abre o
 * próprio modal. No app o cabeçalho sai e o botão vai para o trilho, que está
 * FORA das rotas: o trilho e a rota precisam concordar num estado só, e nenhum
 * dos dois é dono do outro. Este é o estado — uma bandeira, sem React (a fábrica)
 * e sem saber o que o painel mostra.
 */
export type PainelDiagnostico = {
  readonly aberto: () => boolean;
  readonly abrir: () => void;
  readonly fechar: () => void;
  readonly assinar: (ouvinte: () => void) => () => void;
};

export function criarPainelDiagnostico(): PainelDiagnostico {
  let aberto = false;
  const ouvintes = new Set<() => void>();
  const mudar = (valor: boolean): void => {
    if (aberto === valor) return;
    aberto = valor;
    for (const o of [...ouvintes]) o();
  };
  return {
    aberto: () => aberto,
    abrir: () => mudar(true),
    fechar: () => mudar(false),
    assinar: (ouvinte) => {
      ouvintes.add(ouvinte);
      return () => {
        ouvintes.delete(ouvinte);
      };
    },
  };
}

/** A instância do produto. Os testes criam a sua. */
export const painelDiagnostico: PainelDiagnostico = criarPainelDiagnostico();

export function useDiagnosticoAberto(painel: PainelDiagnostico = painelDiagnostico): {
  readonly aberto: boolean;
  readonly abrir: () => void;
  readonly fechar: () => void;
} {
  const aberto = useSyncExternalStore(painel.assinar, painel.aberto);
  const abrir = useCallback(() => painel.abrir(), [painel]);
  const fechar = useCallback(() => painel.fechar(), [painel]);
  return { aberto, abrir, fechar };
}
