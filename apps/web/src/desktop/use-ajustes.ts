import { useCallback, useEffect, useState } from 'react';
import { taxaDoEncoder } from './taxa-do-encoder.js';
import type { AjustesDesktop, PonteDesktop, RespostaDeAjustes } from './ponte.js';

export type AjustesDoApp = {
  /** `null` até o main responder (ou sem ponte). */
  readonly ajustes: AjustesDesktop | null;
  /** Há ícone de bandeja? Assume que sim até saber, para não assustar à toa. */
  readonly bandeja: boolean;
  readonly autostartFalhou: boolean;
  readonly mudar: (parcial: Partial<AjustesDesktop>) => void;
  /** Reconsulta o main (ao abrir o painel). */
  readonly recarregar: () => void;
};

/**
 * Os ajustes do app, lidos e gravados no main. Cada mudança grava na hora e a
 * tela passa a mostrar o que o main DEVOLVEU — se o autostart falhou, a caixa
 * volta desmarcada em vez de mentir.
 */
export function useAjustes(ponte: Pick<PonteDesktop, 'ajustes' | 'salvarAjustes'> | undefined): AjustesDoApp {
  const [resposta, setResposta] = useState<RespostaDeAjustes | null>(null);

  const aplicar = useCallback((r: RespostaDeAjustes | null) => {
    // O main devolve `null` a quem não é a interface; nada a mostrar.
    if (r === null) return;
    setResposta(r);
    taxaDoEncoder.definir(r.ajustes.taxaConstante);
  }, []);

  const recarregar = useCallback(() => {
    if (ponte === undefined) return;
    ponte.ajustes().then(aplicar, () => undefined);
  }, [ponte, aplicar]);

  useEffect(recarregar, [recarregar]);

  const mudar = useCallback(
    (parcial: Partial<AjustesDesktop>) => {
      if (ponte === undefined) return;
      ponte.salvarAjustes(parcial).then(aplicar, () => undefined);
    },
    [ponte, aplicar],
  );

  return {
    ajustes: resposta?.ajustes ?? null,
    bandeja: resposta?.bandeja ?? true,
    autostartFalhou: resposta?.autostartFalhou ?? false,
    mudar,
    recarregar,
  };
}
