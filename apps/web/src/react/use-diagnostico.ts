import { useMemo } from 'react';
import type { EstadoAudio } from '../core/media/audio-state.js';
import type { BroadcastState } from '../core/media/broadcast-session.js';
import type { ReadableStats } from './use-media-stats.js';

type EstadoAoVivo = Extract<BroadcastState, { status: 'live' }>;

export type Tom = 'neutro' | 'destaque' | 'ok' | 'alerta';

export type CelulaDiagnostico = {
  readonly rotulo: string;
  readonly valor: string;
  readonly nota: string;
  readonly tom: Tom;
};

export type LinhaEspectador = {
  readonly id: string;
  /** Nome sequencial: o id da malha é opaco e não diz nada a quem lê. */
  readonly nome: string;
  readonly rota: 'P2P direto' | 'TURN (relay)';
  readonly estado: 'assistindo' | 'conectando' | 'reconectando' | 'sem conexão';
  readonly tom: Tom;
};

export type Diagnostico = {
  readonly resumo: readonly CelulaDiagnostico[];
  readonly espectadores: readonly LinhaEspectador[];
  readonly audio: { readonly texto: string; readonly tom: Tom };
};

const TEXTO_AUDIO: Record<EstadoAudio, { texto: string; tom: Tom }> = {
  'sem-fonte': { texto: 'Sem áudio: esta transmissão foi aberta sem som.', tom: 'neutro' },
  encerrada: { texto: 'A fonte de som acabou; os amigos estão sem áudio.', tom: 'alerta' },
  bloqueado: { texto: 'O navegador pausou o áudio; os amigos ouvem silêncio.', tom: 'alerta' },
  mudo: { texto: 'Mudo: o volume da transmissão está em zero.', tom: 'neutro' },
  perda: { texto: 'Som picotando: pacotes de áudio se perdendo no caminho.', tom: 'alerta' },
  'sem-sinal': { texto: 'Nenhum som saindo há 20 segundos. Confira a fonte escolhida.', tom: 'alerta' },
  transmitindo: { texto: 'Som saindo normalmente.', tom: 'ok' },
  desconhecido: { texto: 'Som ligado; ainda sem medida para afirmar mais.', tom: 'neutro' },
};

const LIMITACAO: Record<NonNullable<EstadoAoVivo['motivoDegradacao']>, { valor: string; nota: string; tom: Tom }> = {
  none: { valor: 'NENHUMA', nota: 'o encoder entrega o que foi pedido', tom: 'ok' },
  cpu: { valor: 'CPU', nota: 'encode pesado: quase sempre software', tom: 'alerta' },
  bandwidth: { valor: 'REDE', nota: 'a sua subida não sustenta este degrau', tom: 'alerta' },
  other: { valor: 'OUTRA', nota: 'o navegador reduziu por outro motivo', tom: 'alerta' },
};

function espectador(peer: EstadoAoVivo['peers'][number], indice: number): LinhaEspectador {
  const estado: LinhaEspectador['estado'] =
    peer.connectionState === 'connected'
      ? 'assistindo'
      : peer.connectionState === 'disconnected'
        ? 'reconectando'
        : peer.connectionState === 'failed' || peer.connectionState === 'closed'
          ? 'sem conexão'
          : 'conectando';
  return {
    id: peer.id,
    nome: `ESPECTADOR ${indice + 1}`,
    rota: peer.usingRelay ? 'TURN (relay)' : 'P2P direto',
    estado,
    tom: estado === 'assistindo' ? (peer.usingRelay ? 'alerta' : 'ok') : 'alerta',
  };
}

/**
 * O que o modal de diagnóstico mostra, e NADA que a sessão não saiba.
 *
 * Latência e perda POR espectador não existem no estado — o transporte agrega
 * (`getAggregateStats`) —, então esta tela não as inventa: mostra o pior RTT,
 * que é o que a sessão mede, e diz que é o pior. Por espectador só há o que o
 * `PeerInfo` carrega de verdade: estado da conexão e se o caminho é relay.
 *
 * Função pura e exportada: é o que se testa, sem montar nada.
 */
export function montarDiagnostico(estado: EstadoAoVivo, stats: ReadableStats): Diagnostico {
  const espectadores = estado.peers.map(espectador);
  const viaRelay = estado.peers.filter((p) => p.usingRelay).length;
  const diretos = estado.peers.length - viaRelay;
  const limitacao = LIMITACAO[estado.motivoDegradacao ?? 'none'];

  const conexao: CelulaDiagnostico =
    estado.peers.length === 0
      ? { rotulo: 'CONEXÃO', valor: '—', nota: 'ninguém assistindo ainda', tom: 'neutro' }
      : viaRelay === 0
        ? { rotulo: 'CONEXÃO', valor: 'DIRETA', nota: `${diretos} em P2P, nenhum via TURN`, tom: 'ok' }
        : {
            rotulo: 'CONEXÃO',
            valor: `${viaRelay} VIA TURN`,
            nota: `${diretos} em P2P direto; o relay funciona, com mais latência`,
            tom: 'alerta',
          };

  return {
    resumo: [
      {
        rotulo: 'ESPECTADORES',
        valor: `${estado.peers.length}/${estado.maxPeers}`,
        nota: `${estado.peers.filter((p) => p.connectionState === 'connected').length} recebendo vídeo`,
        tom: 'destaque',
      },
      conexao,
      {
        rotulo: 'IMAGEM MEDIDA',
        valor: stats.resolution,
        nota: `${stats.fps} saindo do encoder`,
        tom: 'neutro',
      },
      {
        rotulo: 'SOBE AGORA',
        valor: stats.bitrate,
        nota: 'somado sobre todos os espectadores',
        tom: 'destaque',
      },
      {
        rotulo: 'PIOR LATÊNCIA',
        valor: stats.rtt,
        nota: 'RTT do pior espectador; o melhor esconderia quem está mal',
        tom: 'neutro',
      },
      { rotulo: 'LIMITAÇÃO', ...limitacao },
    ],
    espectadores,
    audio: TEXTO_AUDIO[estado.audio],
  };
}

export function useDiagnostico(estado: EstadoAoVivo | null, stats: ReadableStats): Diagnostico | null {
  return useMemo(() => (estado === null ? null : montarDiagnostico(estado, stats)), [estado, stats]);
}
