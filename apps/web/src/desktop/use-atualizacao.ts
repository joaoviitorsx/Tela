import { useCallback, useEffect, useState } from 'react';
import type { EstadoDaAtualizacao, PonteDesktop } from './ponte.js';

export type PonteDaAtualizacao = Pick<
  PonteDesktop,
  'atualizacao' | 'aoMudarAtualizacao' | 'verificarAtualizacao' | 'reiniciarEAtualizar'
>;

export type AtualizacaoDoApp = {
  /** `null` até o main responder (ou sem ponte). */
  readonly estado: EstadoDaAtualizacao | null;
  readonly verificar: () => void;
  readonly reiniciar: () => void;
};

/**
 * O estado da atualização, lido do main (D5). A interface não decide nada: o
 * main recusa verificar e reiniciar ao vivo, e os botões já vêm travados por
 * `podeVerificar`/`podeReiniciar`.
 */
export function useAtualizacao(ponte: PonteDaAtualizacao | undefined): AtualizacaoDoApp {
  const [estado, setEstado] = useState<EstadoDaAtualizacao | null>(null);

  useEffect(() => {
    if (ponte === undefined) return undefined;
    let vivo = true;
    // Assina antes de perguntar: uma mudança no meio não se perde. Se ela
    // chegar antes da resposta, a resposta (mais velha) não a atropela.
    let recebeuPush = false;
    const cancelar = ponte.aoMudarAtualizacao((novo) => {
      recebeuPush = true;
      setEstado(novo);
    });
    ponte.atualizacao().then(
      (inicial) => {
        if (vivo && !recebeuPush && inicial !== null) setEstado(inicial);
      },
      () => undefined,
    );
    return () => {
      vivo = false;
      cancelar();
    };
  }, [ponte]);

  const verificar = useCallback(() => ponte?.verificarAtualizacao(), [ponte]);
  const reiniciar = useCallback(() => ponte?.reiniciarEAtualizar(), [ponte]);
  return { estado, verificar, reiniciar };
}
