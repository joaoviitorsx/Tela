import { useEffect, useState } from 'react';
import type { EstadoDaJanela, PonteDesktop } from './ponte.js';

export type PonteDaBarra = Pick<PonteDesktop, 'plataforma' | 'janela'>;

const INICIAL: EstadoDaJanela = { focada: true, maximizada: false, telaCheia: false };

export type BarraDaJanela = {
  readonly plataforma: 'win32' | 'linux';
  readonly estado: EstadoDaJanela;
  readonly minimizar: () => void;
  readonly alternarMaximizar: () => void;
  readonly fechar: () => void;
};

/**
 * A barra própria da janela (§11) só existe no app, no Windows e no Linux.
 * Sem ponte (dev no navegador) e no macOS (não é alvo) devolve `null`.
 * O estado vem do main; quem decide o que cada botão faz é ele.
 */
export function useBarraDaJanela(ponte: PonteDaBarra | undefined): BarraDaJanela | null {
  const [estado, setEstado] = useState<EstadoDaJanela>(INICIAL);
  const janela = ponte?.janela;
  useEffect(() => {
    if (janela === undefined) return undefined;
    return janela.aoMudarEstado(setEstado);
  }, [janela]);

  if (ponte === undefined || ponte.janela === undefined) return null;
  const { plataforma } = ponte;
  if (plataforma !== 'win32' && plataforma !== 'linux') return null;
  return {
    plataforma,
    estado,
    minimizar: () => ponte.janela.minimizar(),
    alternarMaximizar: () => ponte.janela.alternarMaximizar(),
    fechar: () => ponte.janela.fechar(),
  };
}
