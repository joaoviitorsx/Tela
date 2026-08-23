import type { Connection } from '@tela/shared';
import type { RoomName } from '../domain/room.js';

/**
 * Emite a credencial de mídia e diz ao cliente como se conectar.
 *
 * Retorna a união discriminada `Connection` de @tela/shared: o adapter do SFU
 * devolve `{transport:'sfu', token, wsUrl}`, o adapter P2P devolve
 * `{transport:'p2p', ticket, signalUrl, iceServers}`. Quem chama só repassa.
 */
export type TokenIssuer = {
  forPublisher(room: RoomName, identity: string): Promise<Connection>;
  forViewer(room: RoomName, identity: string): Promise<Connection>;
};
