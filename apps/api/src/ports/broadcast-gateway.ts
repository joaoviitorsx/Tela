import type { RoomName } from '../domain/room.js';

/**
 * O que o transporte de mídia precisa que o servidor faça.
 *
 * No modo SFU isso vira chamadas ao LiveKit. No modo P2P vira operação no hub
 * de sinalização local. O caso de uso não sabe a diferença — é por isso que
 * trocar de topologia não toca em application/.
 */
export type BroadcastGateway = {
  /** Cria a sala se não existir. Nunca depende de auto_create do SFU. */
  ensureRoom(room: RoomName, capacity: number): Promise<void>;
  /** Encerra a sala e derruba quem estiver dentro. */
  closeRoom(room: RoomName): Promise<void>;
  /** Para o /health. Não deve lançar — retorna false se o upstream não responde. */
  isHealthy(): Promise<boolean>;
};
