import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { PresetId } from '../core/media/presets.js';
import type { BroadcastSession, BroadcastState } from '../core/media/broadcast-session.js';

/**
 * Ponte fina entre a sessão e o React. Zero lógica.
 *
 * `useSyncExternalStore` em vez de `useState` + `useEffect` porque a sessão JÁ
 * é a fonte da verdade — duplicar o estado num store React criaria duas
 * versões da mesma coisa, e uma delas ficaria velha (AGENTS.md R1).
 */
export function useBroadcast(session: BroadcastSession): {
  state: BroadcastState;
  start: (
    slug: string,
    ownerToken: string,
    presetId?: PresetId,
    audioDeviceId?: string | null,
  ) => Promise<void>;
  stop: () => Promise<void>;
  setPreset: (presetId: PresetId) => Promise<void>;
} {
  const state = useSyncExternalStore(
    useCallback((listener) => session.subscribe(listener), [session]),
    useCallback(() => session.getState(), [session]),
    useCallback(() => session.getState(), [session]),
  );

  return useMemo(
    () => ({
      state,
      start: (slug, ownerToken, presetId, audioDeviceId) =>
        session.start(slug, ownerToken, {
          ...(presetId === undefined ? {} : { presetId }),
          ...(audioDeviceId === null || audioDeviceId === undefined
            ? {}
            : { audioDeviceId }),
        }),
      stop: () => session.stop('USER_STOPPED'),
      setPreset: (presetId) => session.setPreset(presetId),
    }),
    [session, state],
  );
}
