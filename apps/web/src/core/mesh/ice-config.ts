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
export function isRelayed(report: RTCStatsReport): boolean {
  let relayed = false;
  const candidates = new Map<string, string>();

  report.forEach((entry) => {
    const stat = entry as Record<string, unknown>;
    if (stat['type'] === 'local-candidate' || stat['type'] === 'remote-candidate') {
      const id = stat['id'];
      const kind = stat['candidateType'];
      if (typeof id === 'string' && typeof kind === 'string') candidates.set(id, kind);
    }
  });

  report.forEach((entry) => {
    const stat = entry as Record<string, unknown>;
    if (stat['type'] !== 'candidate-pair' || stat['state'] !== 'succeeded') return;
    const local = stat['localCandidateId'];
    const remote = stat['remoteCandidateId'];
    if (typeof local === 'string' && candidates.get(local) === 'relay') relayed = true;
    if (typeof remote === 'string' && candidates.get(remote) === 'relay') relayed = true;
  });

  return relayed;
}
