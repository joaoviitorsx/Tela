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

/** A resposta em português a "meus amigos estão vendo bem?" (C-05). */
export type Veredito = { readonly tom: Tom; readonly texto: string };

export type Diagnostico = {
  /** O que ler primeiro; a grade técnica fica atrás de VER DETALHES. */
  readonly veredito: Veredito;
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

const amigos = (n: number): string => (n === 1 ? '1 amigo' : `${n} amigos`);

/**
 * Uma frase, com o LED do tom: o que está acontecendo e o que fazer. Os casos
 * vão do mais grave ao mais leve, e o primeiro que casa vence — quem lê só
 * tem tempo para uma coisa.
 */
function montarVeredito(estado: EstadoAoVivo, stats: ReadableStats): Veredito {
  const conectados = estado.peers.filter((p) => p.connectionState === 'connected').length;
  const viaRelay = estado.peers.filter((p) => p.usingRelay).length;
  const saindo = stats.resolution === '—' ? '' : ` ${stats.resolution}`;

  if (estado.peers.length === 0) {
    return {
      tom: 'neutro',
      texto: 'Aguardando o primeiro amigo. Quando alguém entrar, a qualidade e a conexão aparecem aqui.',
    };
  }
  if (estado.motivoDegradacao === 'cpu') {
    return {
      tom: 'alerta',
      texto: `! O seu computador não está dando conta de codificar: enviando${saindo}. Feche programas pesados.`,
    };
  }
  if (estado.motivoDegradacao === 'bandwidth') {
    return {
      tom: 'alerta',
      texto: `! Sua subida não sustenta esta qualidade: enviando${saindo}. Volta sozinha quando a rede sobrar.`,
    };
  }
  // O mesmo aviso que o console já mostra no banner: veredito e banner não se contradizem.
  if (stats.warning !== null) {
    return { tom: 'alerta', texto: `! ${stats.warning}. Enviando${saindo || ' uma imagem menor'}.` };
  }
  if (conectados < estado.peers.length) {
    const faltam = estado.peers.length - conectados;
    return {
      tom: 'alerta',
      texto: `! ${amigos(faltam)} ainda ${faltam === 1 ? 'não está recebendo' : 'não estão recebendo'} a imagem: conectando ou sem conexão.`,
    };
  }
  if (viaRelay > 0) {
    return {
      tom: 'alerta',
      texto: `! ${amigos(viaRelay)} ${viaRelay === 1 ? 'está' : 'estão'} pela rota alternativa (TURN): funciona, com um pouco mais de atraso.`,
    };
  }
  const audio = TEXTO_AUDIO[estado.audio];
  if (audio.tom === 'alerta') return { tom: 'alerta', texto: `! ${audio.texto}` };
  return {
    tom: 'ok',
    texto: `Tudo certo: ${amigos(conectados)} recebendo${saindo}${stats.fps === '—' ? '' : ` a ${stats.fps}`}, em conexão direta.`,
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
    veredito: montarVeredito(estado, stats),
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
      {
        rotulo: 'DENSIDADE',
        valor: stats.qp === '—' ? stats.bpp : `${stats.bpp} · QP ${stats.qp}`,
        nota: 'bits por pixel: abaixo de 0,10 a imagem borra; QP acima de 37 o navegador corta resolução',
        tom: stats.bppBaixo || stats.qpAlto ? 'alerta' : 'neutro',
      },
      {
        rotulo: 'ENCODER',
        valor: stats.encoder,
        nota:
          stats.msPorQuadro === '—'
            ? 'custo por quadro ainda sem medida'
            : `${stats.msPorQuadro} por quadro${stats.encoderLento ? ': não dá conta de 60 fps' : ''}`,
        tom: stats.encoderLento || stats.encoder === 'software' ? 'alerta' : 'neutro',
      },
    ],
    espectadores,
    audio: TEXTO_AUDIO[estado.audio],
  };
}

export function useDiagnostico(estado: EstadoAoVivo | null, stats: ReadableStats): Diagnostico | null {
  return useMemo(() => (estado === null ? null : montarDiagnostico(estado, stats)), [estado, stats]);
}
