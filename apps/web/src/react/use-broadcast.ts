import { useCallback, useSyncExternalStore } from 'react';
import type { BroadcastSession, BroadcastState } from '../core/media/broadcast-session.js';
import type { Prioridade } from '@tela/shared';
import type { PresetId } from '../core/media/presets.js';

export type BroadcastControls = {
  state: BroadcastState;
  start: (
    slug: string,
    ownerToken: string,
    presetId?: PresetId,
    audioDeviceId?: string | null,
  ) => Promise<void>;
  stop: () => Promise<void>;
  setPreset: (presetId: PresetId) => Promise<void>;
  /** Abre o seletor de novo e troca a fonte sem derrubar espectadores. */
  switchSource: () => Promise<void>;
  setPrioridade: (prioridade: Prioridade) => Promise<void>;
  /** Volume do que os espectadores ouvem. Síncrono: mexe num GainNode. */
  setVolumeTransmissao: (volume: number) => void;
  /** Retoma o áudio suspenso pelo navegador. Chamar dentro do clique. */
  retomarAudio: () => Promise<void>;
  /** Troca o convite; `true` quando o servidor confirmou. */
  renovarConvite: () => Promise<boolean>;
  desconectarTodos: () => void;
  /** Pausa de privacidade: quadro neutro no lugar da tela; som só se pedido. */
  pausar: (opcoes?: { readonly manterSom?: boolean }) => Promise<void>;
  retomar: () => Promise<void>;
};

/**
 * Ponte fina entre a sessão e o React. Zero lógica.
 *
 * `useSyncExternalStore` em vez de `useState` + `useEffect` porque a sessão JÁ
 * é a fonte da verdade — duplicar o estado num store React criaria duas
 * versões da mesma coisa, e uma delas ficaria velha (AGENTS.md R1).
 *
 * # As ações precisam ser REFERENCIALMENTE ESTÁVEIS
 *
 * Elas dependem só de `session`, nunca de `state`. Isso não é otimização: é
 * correção.
 *
 * Quando `start` era recriado a cada mudança de estado, todo efeito que o
 * tivesse nas dependências re-rodava a cada transição — e o cleanup desse
 * efeito parava a transmissão. Na prática: a primeira transição
 * (`idle → requesting-capture`) já matava a sessão, e o usuário via
 * "Transmissão encerrada" antes mesmo do seletor de tela aparecer.
 *
 * Em produção, não só em desenvolvimento.
 */
export function useBroadcast(session: BroadcastSession): BroadcastControls {
  const state = useSyncExternalStore(
    useCallback((listener) => session.subscribe(listener), [session]),
    useCallback(() => session.getState(), [session]),
    useCallback(() => session.getState(), [session]),
  );

  const start = useCallback<BroadcastControls['start']>(
    (slug, ownerToken, presetId, audioDeviceId) =>
      session.start(slug, ownerToken, {
        ...(presetId === undefined ? {} : { presetId }),
        ...(audioDeviceId === null || audioDeviceId === undefined ? {} : { audioDeviceId }),
      }),
    [session],
  );

  const stop = useCallback(() => session.stop('USER_STOPPED'), [session]);
  const setPreset = useCallback((presetId: PresetId) => session.setPreset(presetId), [session]);
  const switchSource = useCallback(() => session.switchSource(), [session]);
  const setPrioridade = useCallback(
    (prioridade: Prioridade) => session.setPrioridade(prioridade),
    [session],
  );

  const setVolumeTransmissao = useCallback(
    (volume: number) => session.setVolumeTransmissao(volume),
    [session],
  );

  const retomarAudio = useCallback(() => session.retomarAudio(), [session]);
  const renovarConvite = useCallback(() => session.renovarConvite(), [session]);
  const desconectarTodos = useCallback(() => session.desconectarTodos(), [session]);
  const pausar = useCallback(
    (opcoes?: { readonly manterSom?: boolean }) => session.pausar(opcoes),
    [session],
  );
  const retomar = useCallback(() => session.retomar(), [session]);

  return {
    state,
    start,
    stop,
    setPreset,
    switchSource,
    setPrioridade,
    setVolumeTransmissao,
    retomarAudio,
    renovarConvite,
    desconectarTodos,
    pausar,
    retomar,
  };
}
