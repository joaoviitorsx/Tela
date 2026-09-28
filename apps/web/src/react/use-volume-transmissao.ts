import { useCallback, useState } from 'react';
import type { PreferenciaVolume } from './use-volume.js';

export type VolumeTransmissao = {
  /** 0 a 1. O que os ESPECTADORES ouvem — não o alto-falante de quem transmite. */
  readonly volume: number;
  readonly definir: (valor: number) => void;
};

/**
 * O `null` PRECISA ser tratado antes do `Number`: `Number(null)` é 0, não NaN,
 * e 0 passa numa guarda de intervalo. Sem preferência guardada — a PRIMEIRA
 * transmissão de todo mundo — o volume nascia em zero e o produto mandava
 * silêncio aos amigos.
 */
export function lerVolumeGuardado(bruto: string | null): number {
  if (bruto === null) return 1;
  const valor = Number(bruto);
  return Number.isFinite(valor) && valor >= 0 && valor <= 1 ? valor : 1;
}

/**
 * O volume da transmissão, lembrado entre sessões.
 *
 * Vive num hook porque dois lugares o usam: o passo "Áudio" da tela inicial,
 * onde ainda não há sessão e só a preferência muda, e o painel ao vivo, onde
 * `aplicar` empurra o valor para o grafo de ganho. Quem abaixou para conversar
 * na call ontem espera que continue abaixado hoje.
 */
export function useVolumeTransmissao(
  pref: PreferenciaVolume,
  aplicar?: (valor: number) => void,
): VolumeTransmissao {
  const [volume, setVolume] = useState(() => lerVolumeGuardado(pref.read()));

  const definir = useCallback(
    (valor: number) => {
      const limitado = Math.min(1, Math.max(0, valor));
      setVolume(limitado);
      pref.write(limitado.toFixed(2));
      aplicar?.(limitado);
    },
    [pref, aplicar],
  );

  return { volume, definir };
}
