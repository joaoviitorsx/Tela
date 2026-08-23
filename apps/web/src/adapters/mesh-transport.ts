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
        /**
         * Queda do canal NÃO é queda da transmissão.
         *
         * As `RTCPeerConnection` já estabelecidas seguem funcionando sem o
         * servidor — é literalmente o argumento da arquitetura. Emitir
         * `closed` aqui derrubava tudo em menos de dois segundos e
         * contradizia o que o README, a regra R8 e a ADR 0005 afirmam.
         */
        deps.channel.on('closed', () => emitter.emit('signaling-lost', undefined)),
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

          /**
           * `ontrack` NÃO significa que o vídeo está chegando.
           *
           * Ele dispara quando o transceiver é montado a partir do SDP — antes
           * de um único pacote de mídia atravessar a rede. Declarar "assistindo"
           * aqui era o motivo de o espectador ver uma tela preta com o produto
           * afirmando que estava tudo bem: o elemento de vídeo existia, o
           * estado dizia `watching`, e nenhum frame nunca chegava.
           *
           * O sinal correto é o `unmute` da trilha remota: ela nasce `muted` e
           * desmuta quando os primeiros pacotes de fato aterrissam. Se o ICE
           * não fechar — o caso de quem precisa de TURN e não tem — o `unmute`
           * simplesmente não vem, e o relógio da sessão trata como falha em
           * vez de deixar a pessoa olhando para o preto.
           */
          const anunciar = () => {
            if (track.kind === 'video') {
              if (delivered) return;
              delivered = true;
            }
            emitter.emit('track', { stream: media });
          };

          if (track.muted) track.addEventListener('unmute', anunciar, { once: true });
          else anunciar();
        },
        onStateChange: (state) => {
          if (state === 'disconnected') emitter.emit('reconnecting', undefined);
          if (state === 'connected' && delivered) emitter.emit('reconnected', undefined);
          // Sem TURN, um par atrás de NAT simétrico chega exatamente aqui.
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
        // Idem no espectador: perder o canal não é perder o vídeo.
        deps.channel.on('closed', () => emitter.emit('signaling-lost', undefined)),
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
