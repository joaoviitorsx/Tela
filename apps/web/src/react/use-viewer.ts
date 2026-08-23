import { useCallback, useSyncExternalStore } from 'react';
import type { ViewerSession, ViewerState } from '../core/media/viewer-session.js';

export function useViewer(session: ViewerSession): ViewerState {
  return useSyncExternalStore(
    useCallback((listener) => session.subscribe(listener), [session]),
    useCallback(() => session.getState(), [session]),
    useCallback(() => session.getState(), [session]),
  );
}
