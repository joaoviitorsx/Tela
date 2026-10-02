import type { BroadcastState } from '../core/media/broadcast-session.js';
import type { EstadoAoVivo } from './ponte.js';

/**
 * O que a moldura mostra e conta ao main sobre a transmissão (D4). Puro: a
 * sessão entra, números e textos saem.
 */
export const FORA_DO_AR: EstadoAoVivo = {
  noAr: false,
  inicioMs: null,
  assistindo: 0,
  capacidade: 0,
  link: null,
  oculto: false,
};

/**
 * O estado para o main. `assistindo` é quem está de fato recebendo imagem (a
 * mesma conta do console da rota), `capacidade` o teto da sala.
 */
export function estadoParaOMain(state: BroadcastState, inicioMs: number | null): EstadoAoVivo {
  if (state.status !== 'live') return FORA_DO_AR;
  return {
    noAr: true,
    inicioMs,
    assistindo: state.peers.filter((p) => p.connectionState === 'connected').length,
    capacidade: state.maxPeers,
    link: state.shareUrl,
    oculto: state.pausa !== null,
  };
}

export function mesmoEstado(a: EstadoAoVivo, b: EstadoAoVivo): boolean {
  return (
    a.noAr === b.noAr &&
    a.inicioMs === b.inicioMs &&
    a.assistindo === b.assistindo &&
    a.capacidade === b.capacidade &&
    a.link === b.link &&
    a.oculto === b.oculto
  );
}

export type RotaDoPainel = 'direta' | 'TURN' | 'mista' | '—';

/**
 * A rota dos espectadores: P2P direto, via TURN (relay) ou os dois. TURN é o
 * que gasta a cota e pesa na latência — o que a pessoa precisa ver de relance.
 */
export function rotaDosEspectadores(state: BroadcastState): RotaDoPainel {
  if (state.status !== 'live') return '—';
  const conectados = state.peers.filter((p) => p.connectionState === 'connected');
  if (conectados.length === 0) return '—';
  const viaTurn = conectados.filter((p) => p.usingRelay).length;
  return viaTurn === 0 ? 'direta' : viaTurn === conectados.length ? 'TURN' : 'mista';
}

/**
 * O encoder em uma palavra legível. O transporte devolve `nativo·NVENC`,
 * `WebCodecs·hardware`, `WebCodecs·software` ou `WebCodecs`; qualquer outro
 * texto (`OpenH264`…) passa como veio. `—` sem leitura.
 */
export function rotuloDoEncoder(state: BroadcastState): string {
  if (state.status !== 'live') return '—';
  const impl = state.stats?.encoderImplementation ?? null;
  return impl === null || impl === '' ? '—' : impl.slice(0, 40);
}

/**
 * Atrasa e funde as atualizações para o main: no máximo uma por `intervaloMs`,
 * só quando o estado MUDOU, e sempre entregando o mais recente (borda de
 * descida). A primeira vai na hora — o main precisa saber que foi ao ar.
 */
export type EmissorDeEstado = {
  readonly empurrar: (estado: EstadoAoVivo) => void;
  readonly cancelar: () => void;
};

export function criarEmissorDeEstado(deps: {
  readonly enviar: (estado: EstadoAoVivo) => void;
  readonly agora: () => number;
  readonly agendar: (fn: () => void, ms: number) => () => void;
  readonly intervaloMs?: number;
}): EmissorDeEstado {
  const intervalo = deps.intervaloMs ?? 1000;
  let ultimoEnviado: EstadoAoVivo | null = null;
  let instanteDoEnvio = -Infinity;
  let pendente: EstadoAoVivo | null = null;
  let cancelarEspera: (() => void) | null = null;

  const enviarAgora = (estado: EstadoAoVivo): void => {
    pendente = null;
    if (ultimoEnviado !== null && mesmoEstado(ultimoEnviado, estado)) return;
    ultimoEnviado = estado;
    instanteDoEnvio = deps.agora();
    deps.enviar(estado);
  };

  return {
    empurrar: (estado) => {
      // O main começa em "fora do ar" (e volta a ele a cada carga da página):
      // o primeiro "fora do ar" é o que ele já sabe, não precisa de IPC.
      if (ultimoEnviado === null && !estado.noAr) {
        ultimoEnviado = estado;
        return;
      }
      if (ultimoEnviado !== null && mesmoEstado(ultimoEnviado, estado) && pendente === null) return;
      const espera = instanteDoEnvio + intervalo - deps.agora();
      if (espera <= 0 && cancelarEspera === null) {
        enviarAgora(estado);
        return;
      }
      pendente = estado;
      if (cancelarEspera !== null) return;
      cancelarEspera = deps.agendar(() => {
        cancelarEspera = null;
        if (pendente !== null) enviarAgora(pendente);
      }, Math.max(0, espera));
    },
    cancelar: () => {
      cancelarEspera?.();
      cancelarEspera = null;
      pendente = null;
    },
  };
}

const dois = (n: number): string => String(n).padStart(2, '0');

/** `42` s → `00:42`; `3725` s → `1:02:05`. */
export function tempoNoAr(inicioMs: number | null, agora: number): string {
  if (inicioMs === null) return '--:--';
  const total = Math.max(0, Math.floor((agora - inicioMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return h > 0 ? `${h}:${dois(m)}:${dois(s)}` : `${dois(m)}:${dois(s)}`;
}
