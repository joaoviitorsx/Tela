import type { EncodingPreset } from '@tela/shared';
import { Emitter } from '../core/emitter.js';
import { StatsSampler } from '../core/media/stats-sampler.js';
import { isRelayed } from '../core/mesh/ice-config.js';
import { MeshTopology, type PeerInfo } from '../core/mesh/mesh-topology.js';
import { PeerLink } from '../core/mesh/peer-link.js';
import type {
  MediaStats,
  MediaTransport,
  TransportEvents,
} from '../core/ports/media-transport.js';
import type { SignalingChannel } from '../core/ports/signaling-channel.js';

/**
 * `MediaTransport` sobre mesh P2P — a implementação viva do produto.
 *
 * A mídia vai direto de browser para browser. O canal de sinalização só
 * carrega `payload` opaco: se este arquivo mandasse qualquer coisa que o
 * servidor precisasse entender, teria quebrado a R8 e o servidor teria virado
 * parte do caminho da mídia.
 */
export type MeshTransportDeps = {
  readonly channel: SignalingChannel;
  /** Injetada para `core/` rodar sem DOM no teste e trocar de stack na Fase 3. */
  readonly createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
};

export function makeMeshTransport(deps: MeshTransportDeps): MediaTransport {
  const emitter = new Emitter<TransportEvents>();
  const outbound = new StatsSampler('outbound');
  const inbound = new StatsSampler('inbound');
  const createConnection =
    deps.createConnection ?? ((config: RTCConfiguration) => new RTCPeerConnection(config));

  const unsubscribes: Array<() => void> = [];
  let topology: MeshTopology | null = null;
  let viewerLink: PeerLink | null = null;
  let stream: MediaStream | null = null;
  /** Por instância. Módulo-global seria compartilhado entre transmissões. */
  let preset: EncodingPreset | null = null;

  const mediaStream = (): MediaStream => (stream ??= new MediaStream());

  async function republish(): Promise<void> {
    if (topology === null || preset === null) return;
    const media = mediaStream();
    await topology.publish(media, media.getTracks(), preset);
  }

  return {
    async host(slug, ownerToken) {
      const opened = await deps.channel.host(slug, ownerToken);

      const mesh = new MeshTopology({
        iceServers: opened.iceServers,
        send: (payload, to) => deps.channel.send(payload, to),
        createConnection,
        maxPeers: opened.maxPeers,
      });
      topology = mesh;

      unsubscribes.push(
        mesh.on('peers', (peers) => emitter.emit('peers', peers)),
        deps.channel.on('peer-joined', ({ peerId }) => mesh.admit(peerId)),
        deps.channel.on('peer-left', ({ peerId }) => mesh.drop(peerId)),
        deps.channel.on('signal', ({ from, payload }) => void mesh.handleSignal(from, payload)),
        deps.channel.on('closed', ({ reason }) => emitter.emit('closed', { reason })),
      );
    },

    async watch(slug) {
      const opened = await deps.channel.watch(slug);
      const media = mediaStream();
      let delivered = false;

      // O espectador é polite: na colisão de oferta ele recua. O transmissor
      // tem a mídia e não pode recuar — a assimetria é essa, e é o que faz o
      // perfect negotiation convergir.
      const link = new PeerLink({
        peerId: opened.hostId ?? 'host',
        polite: true,
        iceServers: opened.iceServers,
        send: (payload) => deps.channel.send(payload),
        createConnection,
        onTrack: (track) => {
          media.addTrack(track);
          link.minimizePlayoutDelay();

          if (!delivered && track.kind === 'video') {
            delivered = true;
            emitter.emit('track', { stream: media });
            return;
          }
          /**
           * O áudio quase sempre chega DEPOIS do primeiro frame de vídeo.
           *
           * Emitir só uma vez deixava a sessão com `hasAudio: false` para
           * sempre — e é esse campo que decide se o overlay "clique para
           * ativar o som" aparece. Sem ele o espectador fica mudo sem nunca
           * saber que existe som para ouvir.
           */
          if (delivered && track.kind === 'audio') {
            emitter.emit('track', { stream: media });
          }
        },
        onStateChange: (state) => {
          if (state === 'disconnected') emitter.emit('reconnecting', undefined);
          if (state === 'connected' && delivered) emitter.emit('reconnected', undefined);
          if (state === 'failed') emitter.emit('closed', { reason: 'ICE_FAILED' });
        },
      });
      viewerLink = link;

      unsubscribes.push(
        deps.channel.on('signal', ({ payload }) => {
          void link.handleSignal(payload).catch(() => {
            emitter.emit('closed', { reason: 'NEGOTIATION_FAILED' });
          });
        }),
        deps.channel.on('peer-left', () => emitter.emit('closed', { reason: 'HOST_LEFT' })),
        deps.channel.on('closed', ({ reason }) => emitter.emit('closed', { reason })),
      );
    },

    async publishVideo(track, next) {
      preset = next;
      const media = mediaStream();
      if (!media.getTracks().includes(track)) media.addTrack(track);
      await republish();
    },

    async publishAudio(track) {
      const media = mediaStream();
      if (!media.getTracks().includes(track)) media.addTrack(track);
      await republish();
    },

    async setPreset(next) {
      preset = next;
      // Sem renegociar: `setParameters` nos senders existentes. Ninguém pisca.
      await topology?.setPreset(next);
    },

    async setBitrateCeiling(bps) {
      await topology?.setCeiling(bps);
    },

    async getAggregateStats(): Promise<MediaStats | null> {
      if (topology !== null) {
        const reports = await topology.collectStats();
        if (reports.length === 0) return null;
        void topology.refreshRelayStatus(isRelayed);
        return outbound.readMany(reports);
      }
      if (viewerLink !== null) return inbound.read(await viewerLink.stats());
      return null;
    },

    peers(): readonly PeerInfo[] {
      return topology?.peers ?? [];
    },

    on(event, handler) {
      return emitter.on(event, handler);
    },

    async disconnect() {
      for (const off of unsubscribes) off();
      unsubscribes.length = 0;
      topology?.close();
      topology = null;
      viewerLink?.close();
      viewerLink = null;
      stream = null;
      preset = null;
      deps.channel.close();
      emitter.clear();
    },
  };
}
