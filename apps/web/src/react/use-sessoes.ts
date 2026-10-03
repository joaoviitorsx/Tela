import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { ViewerSession, ViewerState } from '../core/media/viewer-session.js';

/**
 * Uma `ViewerSession` por canal na tela, estável enquanto o canal estiver lá
 * (ADR 0032). Trocar a principal não cria nem fecha sessão nenhuma; tirar um
 * canal só esquece a dele — quem a fecha é o painel, ao desmontar.
 *
 * O mapa vive num ref e é ajustado no render: são no máximo dois canais, e a
 * sessão não faz nada antes do `open` (que é efeito do painel).
 */
export function useSessoes(canais: readonly string[], criar: () => ViewerSession): ReadonlyMap<string, ViewerSession> {
  const mapa = useRef(new Map<string, ViewerSession>());
  for (const canal of canais) if (!mapa.current.has(canal)) mapa.current.set(canal, criar());
  for (const canal of [...mapa.current.keys()]) if (!canais.includes(canal)) mapa.current.delete(canal);
  return mapa.current;
}

const nada = () => () => undefined;

/** `useViewer` para uma sessão que pode não existir (a secundária). */
export function useViewerOpcional(session: ViewerSession | null): ViewerState | null {
  return useSyncExternalStore(
    useCallback((ouvinte: () => void) => (session === null ? nada() : session.subscribe(ouvinte)), [session]),
    useCallback(() => session?.getState() ?? null, [session]),
    useCallback(() => session?.getState() ?? null, [session]),
  );
}
