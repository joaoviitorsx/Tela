import { useEffect } from 'react';

/**
 * Detalhes pequenos que separam "funciona" de "dá pra usar por três horas".
 * Ficam num arquivo só porque todos são o mesmo tipo de coisa: efeito de
 * página, sem regra de negócio.
 */

/** Achar a aba entre trinta outras. O ponto vermelho é o que o olho procura. */
export function useTabTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** Impede a tela de apagar durante a transmissão. Falha em silêncio onde não existe. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen');
      } catch {
        // Bateria fraca ou aba em segundo plano: o browser recusa. Sem drama.
      }
    };

    void acquire();
    // O browser solta o lock sozinho quando a aba perde o foco; ao voltar,
    // é preciso pedir de novo ou a tela apaga no meio do jogo.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !released) void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    };
  }, [active]);
}

/** Encerra a sala na hora quando o usuário só fecha a aba. */
export function useBeforeUnload(active: boolean, onUnload: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = () => onUnload();
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [active, onUnload]);
}

/** Atalhos de teclado. Ignora quando o foco está num campo de texto. */
export function useHotkeys(map: Record<string, () => void>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return;
      const action = map[event.key.toLowerCase()];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [map, enabled]);
}
