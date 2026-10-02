import { vi } from 'vitest';
import type { BroadcastState } from '../core/media/broadcast-session.js';
import type { PeerInfo } from '../core/ports/media-transport.js';
import type { SessaoObservavel } from './sessao-ao-vivo.js';

/** Só para testes: um `live` com o que a moldura lê; o resto não importa para ela. */
export function estadoVivo(opcoes: {
  readonly peers?: readonly PeerInfo[];
  readonly encoder?: string | null;
  readonly maxPeers?: number;
} = {}): BroadcastState {
  const stats = { encoderImplementation: opcoes.encoder ?? null };
  return {
    status: 'live',
    shareUrl: 'https://tela.gg/jv',
    slug: 'jv',
    maxPeers: opcoes.maxPeers ?? 50,
    peers: opcoes.peers ?? [],
    stats,
    pausa: null,
  } as unknown as BroadcastState;
}

export const par = (id: string, estado: RTCPeerConnectionState, usingRelay = false): PeerInfo => ({
  id,
  connectionState: estado,
  usingRelay,
});

/** Uma sessão de mentira: o estado é trocado à mão, `stop` vira `ended`. */
export function sessaoFalsa(inicial: BroadcastState = { status: 'idle' }) {
  let estado = inicial;
  const ouvintes = new Set<() => void>();
  const stop = vi.fn(async () => {
    estado = { status: 'ended', reason: 'USER_STOPPED' };
    for (const o of [...ouvintes]) o();
  });
  const avisar = () => {
    for (const o of [...ouvintes]) o();
  };
  const pausar = vi.fn(async (opcoes: { readonly manterSom?: boolean } = {}) => {
    if (estado.status === 'live') estado = { ...estado, pausa: { comSom: opcoes.manterSom === true } };
    avisar();
  });
  const retomar = vi.fn(async () => {
    if (estado.status === 'live') estado = { ...estado, pausa: null };
    avisar();
  });
  const sessao: SessaoObservavel = {
    getState: () => estado,
    subscribe: (o) => {
      ouvintes.add(o);
      return () => ouvintes.delete(o);
    },
    stop,
    pausar,
    retomar,
  };
  return {
    sessao,
    stop,
    pausar,
    retomar,
    mudar: (novo: BroadcastState) => {
      estado = novo;
      for (const o of [...ouvintes]) o();
    },
    ouvintes,
  };
}
