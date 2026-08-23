import { DEGRADATION_PREFERENCE, VIDEO_CODEC, type Connection } from '@tela/shared';
import {
  ConnectionState,
  type DisconnectReason,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
} from 'livekit-client';
import { Emitter } from '../core/emitter.js';
import { StatsSampler } from '../core/media/stats-sampler.js';
import type {
  PublishRequest,
  PublisherEvents,
  PublisherTransport,
  ViewerEvents,
  ViewerTransport,
} from '../core/ports/media-transport.js';
import { minimizePlayoutDelay } from './rtc-codec.js';

/**
 * ÚNICO arquivo do web, junto de p2p-transport.ts, autorizado a conhecer o
 * transporte concreto (AGENTS.md R2). Se `livekit-client` aparecer em
 * `core/`, `components/` ou `routes/`, o lint quebra o build.
 */

function assertSfu(connection: Connection): Extract<Connection, { transport: 'sfu' }> {
  if (connection.transport !== 'sfu') throw new Error('conexão não é sfu');
  return connection;
}

export function makeLiveKitPublisherTransport(): PublisherTransport {
  const emitter = new Emitter<PublisherEvents>();
  const sampler = new StatsSampler('outbound');

  const room = new Room({
    // O transmissor não recebe nada — desligar economiza download durante o jogo.
    adaptiveStream: false,
    // Se ninguém assiste a camada 1080p, o SFU manda parar de codificá-la.
    // Devolve CPU pro jogo sem nenhuma intervenção do usuário.
    dynacast: true,
    publishDefaults: {
      videoCodec: VIDEO_CODEC,
      simulcast: true,
      degradationPreference: DEGRADATION_PREFERENCE,
      backupCodec: false,
    },
  });

  let publication: LocalTrackPublication | null = null;

  const countViewers = () => emitter.emit('viewers', room.numParticipants - 1);

  room
    .on(RoomEvent.ParticipantConnected, countViewers)
    .on(RoomEvent.ParticipantDisconnected, countViewers)
    .on(RoomEvent.Reconnecting, () => emitter.emit('reconnecting', undefined))
    .on(RoomEvent.Reconnected, () => emitter.emit('reconnected', undefined))
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) =>
      emitter.emit('closed', { reason: reason !== undefined ? String(reason) : 'unknown' }),
    );

  return {
    async connect(connection) {
      const sfu = assertSfu(connection);
      await room.connect(sfu.wsUrl, sfu.token);
    },

    async publish(request: PublishRequest) {
      if (publication !== null) {
        await room.localParticipant.unpublishTrack(request.video);
        publication = null;
      }

      publication = await room.localParticipant.publishTrack(request.video, {
        source: Track.Source.ScreenShare,
        videoEncoding: {
          maxBitrate: request.maxBitrate,
          maxFramerate: request.maxFramerate,
          priority: 'high',
        },
        // Exatamente duas camadas (R5). Três encoders 1080p60 derrubam o FPS
        // do jogo, que é o recurso que o produto existe para proteger.
        screenShareSimulcastLayers: request.layers.map((layer) => ({
          width: layer.width,
          height: layer.height,
          encoding: { maxBitrate: layer.maxBitrate, maxFramerate: layer.maxFramerate },
          resolution: { width: layer.width, height: layer.height },
        })) as never,
        degradationPreference: DEGRADATION_PREFERENCE,
      });

      if (request.audio) {
        await room.localParticipant.publishTrack(request.audio, {
          source: Track.Source.ScreenShareAudio,
          audioPreset: { maxBitrate: 128_000 },
          // DTX corta "silêncio"; em jogo isso vira gaguejo. RED adiciona
          // redundância, e redundância custa latência (§10).
          dtx: false,
          red: false,
          stopMicTrackOnMute: false,
        });
      }
    },

    async readStats() {
      const sender = publication?.track?.sender;
      if (!sender) return null;
      return sampler.read(await sender.getStats());
    },

    on(event, handler) {
      return emitter.on(event, handler);
    },

    async close() {
      await room.disconnect();
      emitter.clear();
    },
  };
}

export function makeLiveKitViewerTransport(): ViewerTransport {
  const emitter = new Emitter<ViewerEvents>();
  const sampler = new StatsSampler('inbound');
  const stream = new MediaStream();

  const room = new Room({
    // Espectador recebe: deixa o SFU escolher a camada pela rede dele.
    adaptiveStream: true,
  });

  let receiver: RTCRtpReceiver | null = null;

  return {
    async connect(connection, sink) {
      const sfu = assertSfu(connection);

      await new Promise<void>((resolve, reject) => {
        let delivered = false;

        room
          .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
            if (track.mediaStreamTrack) stream.addTrack(track.mediaStreamTrack);
            if (track.receiver) {
              receiver = track.receiver;
              minimizePlayoutDelay(track.receiver);
            }
            if (!delivered && track.kind === Track.Kind.Video) {
              delivered = true;
              sink(stream);
              emitter.emit('track', { hasAudio: stream.getAudioTracks().length > 0 });
              resolve();
            }
          })
          .on(RoomEvent.Reconnecting, () => emitter.emit('reconnecting', undefined))
          .on(RoomEvent.Reconnected, () => emitter.emit('reconnected', undefined))
          .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
            const text = reason !== undefined ? String(reason) : 'unknown';
            if (!delivered) reject(new Error(text));
            emitter.emit('closed', { reason: text });
          });

        room.connect(sfu.wsUrl, sfu.token, { autoSubscribe: true }).catch(reject);
      });
    },

    async readStats() {
      if (receiver === null) return null;
      return sampler.read(await receiver.getStats());
    },

    on(event, handler) {
      return emitter.on(event, handler);
    },

    async close() {
      if (room.state !== ConnectionState.Disconnected) await room.disconnect();
      for (const track of stream.getTracks()) stream.removeTrack(track);
      emitter.clear();
    },
  };
}
