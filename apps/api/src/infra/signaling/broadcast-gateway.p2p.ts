import type { BroadcastGateway } from '../../ports/broadcast-gateway.js';
import type { SignalingHub } from './hub.js';

/**
 * No modo P2P a "sala" é só uma entrada no hub local.
 *
 * `ensureRoom` não faz nada porque não há nada para provisionar — a sala passa
 * a existir quando o transmissor apresenta o ticket. Isso é o que elimina o
 * modo de falha mais comum do self-host: não há upstream para estar fora do ar.
 */
export function makeP2pGateway(hub: SignalingHub): BroadcastGateway {
  return {
    async ensureRoom() {
      /* sala é criada sob demanda pelo hub, no hello do transmissor */
    },
    async closeRoom(room) {
      hub.closeRoom(room);
    },
    async isHealthy() {
      return true; // o hub é este processo; se ele não estivesse vivo, ninguém responderia
    },
  };
}
