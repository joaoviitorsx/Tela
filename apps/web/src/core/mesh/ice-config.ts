import type { IceServerConfig } from '@tela/shared';

/**
 * Configuração de `RTCPeerConnection` para o mesh.
 *
 * Os servidores ICE vêm SEMPRE do servidor de sinalização, nunca de constante
 * no código: credencial de TURN em bundle estático é credencial pública, e
 * credencial pública de TURN é um relay aberto rodando na sua cota.
 */
export function rtcConfiguration(iceServers: readonly IceServerConfig[]): RTCConfiguration {
  return {
    iceServers: iceServers.map((server) => ({
      urls: server.urls,
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }),
    })),
    // `all`, não `relay`: o caminho direto é o objetivo. O TURN é a rede de
    // segurança de quem está atrás de CGNAT, não o caminho preferencial.
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    /**
     * SEM pré-coleta de candidatos.
     *
     * Um pool > 0 faz o Chrome abrir sockets UDP e disparar STUN antes de
     * qualquer negociação existir. Ganha-se alguns milissegundos até o
     * primeiro frame e paga-se com tráfego e sockets numa máquina que está
     * rodando um jogo. Num produto cujo requisito central é não atrapalhar o
     * jogo, essa troca está do lado errado.
     */
    iceCandidatePoolSize: 0,
  };
}

/**
 * `true` quando o par de candidatos vencedor passa por TURN.
 *
 * A UI mostra isso porque é honesto: relay significa latência maior e cota
 * de terceiro sendo consumida. Esconder transforma uma limitação conhecida
 * em "às vezes fica ruim".
 */
export type SelectedIcePath = {
  readonly source: 'transport' | 'legacy-selected' | 'unique-nominated';
  readonly localType: string | null;
  readonly remoteType: string | null;
  /** Acesso cliente–TURN; candidate.protocol descreve outra coisa. */
  readonly relayProtocol: 'udp' | 'tcp' | 'tls' | null;
  readonly iceState: string | null;
  readonly dtlsState: string | null;
};

function field(stat: Record<string, unknown> | undefined, key: string): string | null {
  const value = stat?.[key];
  return typeof value === 'string' ? value : null;
}

/** Somente o par em uso, nunca qualquer par histórico `succeeded`. */
export function selectedIcePath(report: RTCStatsReport): SelectedIcePath | null {
  const stats = new Map<string, Record<string, unknown>>();
  report.forEach((entry) => {
    const stat = entry as Record<string, unknown>;
    if (typeof stat['id'] === 'string') stats.set(stat['id'], stat);
  });

  const transports = [...stats.values()].filter((stat) => stat['type'] === 'transport');
  const transport = transports.find((stat) => field(stat, 'selectedCandidatePairId') !== null);
  let source: SelectedIcePath['source'] = 'transport';
  let pair = transport === undefined ? undefined : stats.get(field(transport, 'selectedCandidatePairId') ?? '');
  if (transport === undefined) {
    const pairs = [...stats.values()].filter((stat) => stat['type'] === 'candidate-pair');
    const selected = pairs.filter((stat) => stat['selected'] === true);
    if (selected.length === 1) {
      pair = selected[0];
      source = 'legacy-selected';
    } else if (selected.length === 0) {
      const nominated = pairs.filter((stat) => stat['state'] === 'succeeded' && stat['nominated'] === true);
      if (nominated.length === 1) {
        pair = nominated[0];
        source = 'unique-nominated';
      }
    }
  }
  if (pair?.['type'] !== 'candidate-pair') return null;
  const local = stats.get(field(pair, 'localCandidateId') ?? '');
  const remote = stats.get(field(pair, 'remoteCandidateId') ?? '');
  const protocol = field(local, 'relayProtocol');
  return {
    source,
    localType: field(local, 'candidateType'),
    remoteType: field(remote, 'candidateType'),
    relayProtocol: protocol === 'udp' || protocol === 'tcp' || protocol === 'tls' ? protocol : null,
    iceState: field(transport, 'iceState'),
    dtlsState: field(transport, 'dtlsState'),
  };
}

export function isRelayed(report: RTCStatsReport): boolean {
  const path = selectedIcePath(report);
  return path?.localType === 'relay' || path?.remoteType === 'relay';
}
