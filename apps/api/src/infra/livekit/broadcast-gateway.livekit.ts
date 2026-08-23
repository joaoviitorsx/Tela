import { RoomServiceClient } from 'livekit-server-sdk';
import {
  DEPARTURE_TIMEOUT_SECONDS,
  EMPTY_TIMEOUT_SECONDS,
} from '../../domain/broadcast.js';
import type { BroadcastGateway } from '../../ports/broadcast-gateway.js';

export function makeLiveKitGateway(
  httpUrl: string,
  apiKey: string,
  apiSecret: string,
): BroadcastGateway {
  const rooms = new RoomServiceClient(httpUrl, apiKey, apiSecret);

  return {
    async ensureRoom(room, capacity) {
      await rooms.createRoom({
        name: room,
        emptyTimeout: EMPTY_TIMEOUT_SECONDS,
        departureTimeout: DEPARTURE_TIMEOUT_SECONDS,
        maxParticipants: capacity,
      });
    },

    async closeRoom(room) {
      await rooms.deleteRoom(room);
    },

    async isHealthy() {
      try {
        await rooms.listRooms([]);
        return true;
      } catch {
        return false;
      }
    },
  };
}
