import { useEffect, useRef, useState } from 'react';
import type { BroadcastState } from '../core/media/broadcast-session.js';
import { formatarTempo } from './use-tempo-no-ar.js';

export type ResumoDaTransmissao = {
  readonly tempoNoAr: string;
  /** O maior número de amigos conectados ao mesmo tempo. */
  readonly pico: number;
  /** O último degrau que esteve no ar, já no rótulo ('1080p60'). */
  readonly qualidade: string;
};

/**
 * O que aconteceu enquanto esteve no ar, para a tela de fim contar.
 *
 * A sessão não guarda histórico — quando vira `ended` só resta o motivo. Este
 * hook anota ao vivo o que a tela de fim precisa, e zera quando uma nova
 * transmissão começa. `null` quando nunca chegou a ir ao ar.
 */
export function useResumoDaTransmissao(
  state: BroadcastState,
  rotuloDoPreset: (id: string) => string,
  agora: () => number = Date.now,
): ResumoDaTransmissao | null {
  const inicio = useRef<number | null>(null);
  const pico = useRef(0);
  const qualidade = useRef<string | null>(null);
  const [resumo, setResumo] = useState<ResumoDaTransmissao | null>(null);

  const status = state.status;
  const conectados =
    state.status === 'live'
      ? state.peers.filter((p) => p.connectionState === 'connected').length
      : 0;
  const preset = state.status === 'live' ? state.presetId : null;

  useEffect(() => {
    if (status === 'live') {
      if (inicio.current === null) {
        inicio.current = agora();
        pico.current = 0;
        setResumo(null);
      }
      pico.current = Math.max(pico.current, conectados);
      if (preset !== null) qualidade.current = rotuloDoPreset(preset);
      return;
    }
    if (status === 'ended' && inicio.current !== null) {
      setResumo({
        tempoNoAr: formatarTempo(Math.floor((agora() - inicio.current) / 1000)),
        pico: pico.current,
        qualidade: qualidade.current ?? '—',
      });
      inicio.current = null;
    }
  }, [status, conectados, preset, rotuloDoPreset, agora]);

  return resumo;
}
