import { WebhookReceiver } from 'livekit-server-sdk';
import type { RoomEvent } from '../../application/handle-room-event.js';

export type WebhookVerifier = {
  /** `null` quando a assinatura não confere ou o evento não interessa. */
  verify(body: string, authHeader: string | undefined): Promise<RoomEvent | null>;
};

/**
 * Traduz o vocabulário do LiveKit para o vocabulário do domínio.
 *
 * É aqui, e só aqui, que o formato do webhook do LiveKit existe. O caso de uso
 * recebe `RoomEvent`, um tipo nosso — por isso o hub P2P consegue alimentar o
 * mesmo caso de uso sem nenhuma adaptação.
 */
export function makeLiveKitWebhookVerifier(apiKey: string, apiSecret: string): WebhookVerifier {
  const receiver = new WebhookReceiver(apiKey, apiSecret);

  return {
    async verify(body, authHeader) {
      if (!authHeader) return null;
      let event;
      try {
        event = await receiver.receive(body, authHeader);
      } catch {
        return null; // assinatura inválida — descarta em silêncio
      }

      const room = event.room?.name;
      if (!room) return null;

      const identity = event.participant?.identity ?? '';
      const isPublisher = identity.startsWith('p_');

      switch (event.event) {
        case 'room_finished':
          return { kind: 'room_finished', room };
        case 'participant_joined':
          return identity ? { kind: 'participant_joined', room, identity, isPublisher } : null;
        case 'participant_left':
          return identity ? { kind: 'participant_left', room, identity, isPublisher } : null;
        default:
          return null;
      }
    },
  };
}
