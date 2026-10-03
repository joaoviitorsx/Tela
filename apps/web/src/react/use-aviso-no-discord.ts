import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { AvisoAoVivo, EstadoDoAviso } from '../core/aviso/aviso-ao-vivo.js';
import type { BroadcastSession } from '../core/media/broadcast-session.js';

/**
 * Liga a transmissão ao aviso no Discord: entrou em `live`, avisa; saiu de
 * `live` (encerrar, captura parou, falha) ou a aba fechou, a mensagem vira
 * "encerrada". A sessão não sabe que o aviso existe.
 */
export function useAvisoNoDiscord(aviso: AvisoAoVivo, session: BroadcastSession): EstadoDoAviso {
  useEffect(() => {
    let noAr = false;
    const sair = () => {
      if (!noAr) return;
      noAr = false;
      void aviso.aoSair();
    };
    const olhar = () => {
      const s = session.getState();
      if (s.status === 'live' && !noAr) {
        noAr = true;
        void aviso.aoEntrarNoAr(s.slug, s.shareUrl);
      } else if (s.status !== 'live') {
        sair();
      }
    };
    olhar();
    const cancelar = session.subscribe(olhar);
    // `pagehide` e não `beforeunload`: dispara também no fechamento sem pergunta.
    window.addEventListener('pagehide', sair);
    return () => {
      cancelar();
      window.removeEventListener('pagehide', sair);
      sair();
    };
  }, [aviso, session]);

  return useEstadoDoAviso(aviso);
}

export function useEstadoDoAviso(aviso: AvisoAoVivo): EstadoDoAviso {
  return useSyncExternalStore(
    useCallback((ouvinte: () => void) => aviso.subscribe(ouvinte), [aviso]),
    useCallback(() => aviso.getEstado(), [aviso]),
  );
}
