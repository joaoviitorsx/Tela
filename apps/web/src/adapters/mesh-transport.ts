import type { EncodingPreset } from '@tela/shared';
import { Emitter } from '../core/emitter.js';
import { StatsSampler } from '../core/media/stats-sampler.js';
import { isRelayed } from '../core/mesh/ice-config.js';
import { IceLifecycle } from '../core/mesh/ice-lifecycle.js';
import { MeshTopology, type PeerInfo } from '../core/mesh/mesh-topology.js';
import { JITTER_INICIAL_MS, PeerLink } from '../core/mesh/peer-link.js';
import { PeerRecovery } from '../core/mesh/peer-recovery.js';
import type {
  MediaStats,
  MediaTransport,
  TransportEvents,
} from '../core/ports/media-transport.js';
import type { SignalingChannel } from '../core/ports/signaling-channel.js';
import type { Scheduler } from '../core/ports/scheduler.js';

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
  readonly scheduler: Scheduler;
  /** Injetada para `core/` rodar sem DOM no teste e trocar de stack na Fase 3. */
  readonly createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
};

/**
 * Quanto tempo a mídia pode ficar em silêncio antes de ser dada por encerrada.
 *
 * Uma troca de rede ou um soluço de ICE emudece a trilha por alguns segundos
 * e ela volta. Declarar o fim na primeira pausa faria o espectador cair
 * sozinho toda vez que o Wi-Fi oscilasse.
 */
const MEDIA_GRACE_MS = 8_000;

/** Motivos em que o canal não volta: o slug deixou de ser nosso. */
const PERDA_DEFINITIVA: ReadonlySet<string> = new Set(['SLUG_TAKEN', 'SLUG_INVALID']);

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
  let iceLifecycle: IceLifecycle | null = null;
  let viewerNeedsRebuild = false;
  const recoveries = new Map<string, PeerRecovery>();

  const mediaStream = (): MediaStream => (stream ??= new MediaStream());

  async function republish(): Promise<void> {
    if (topology === null || preset === null) return;
    const media = mediaStream();
    await topology.publish(media, media.getTracks(), preset);
  }

  return {
    async host(slug, ownerToken) {
      const opened = await deps.channel.host(slug, ownerToken);

      const recoveryFor = (peerId: string): PeerRecovery => {
        const existing = recoveries.get(peerId);
        if (existing !== undefined) return existing;
        const recovery = new PeerRecovery({
          scheduler: deps.scheduler,
          beforeRestart: () => iceLifecycle?.beforeRestart() ?? Promise.resolve(),
          mediaBytes: () => mesh.mediaBytes(peerId),
          restart: () => mesh.restart(peerId),
          rebuild: () => mesh.rebuild(peerId),
          onRecovering: () => undefined,
          onRecovered: () => undefined,
          onExhausted: () => { mesh.drop(peerId); recoveries.delete(peerId); },
        });
        recoveries.set(peerId, recovery);
        return recovery;
      };

      const mesh = new MeshTopology({
        iceServers: opened.iceServers,
        send: (payload, to) => deps.channel.send(payload, to),
        createConnection,
        maxPeers: opened.maxPeers,
        onIssue: (_peerId, code) => console.warn('[peer-link]', code),
        onPeerStateChange: (peerId, state) => recoveryFor(peerId).observe(state),
      });
      topology = mesh;
      iceLifecycle = new IceLifecycle(deps.channel, deps.scheduler, (lease) => {
        mesh.setIceServers(lease.iceServers);
      });
      iceLifecycle.use(opened);

      unsubscribes.push(
        mesh.on('peers', (peers) => emitter.emit('peers', peers)),
        mesh.on('dropped', ({ peerId }) => {
          recoveries.get(peerId)?.close();
          recoveries.delete(peerId);
        }),
        deps.channel.on('peer-joined', ({ peerId, attemptId }) => mesh.admit(peerId, attemptId)),
        deps.channel.on('peer-left', ({ peerId }) => {
          recoveries.get(peerId)?.close();
          recoveries.delete(peerId);
          mesh.drop(peerId);
        }),
        deps.channel.on('signal', ({ from, payload }) => void mesh.handleSignal(from, payload)),
        /**
         * Queda do canal NÃO é queda da transmissão.
         *
         * As `RTCPeerConnection` já estabelecidas seguem funcionando sem o
         * servidor — é literalmente o argumento da arquitetura. Emitir
         * `closed` aqui derrubava tudo em menos de dois segundos e
         * contradizia o que o README, a regra R8 e a ADR 0005 afirmam.
         */
        /**
         * Perder o CANAL é diferente de perder o SLUG.
         *
         * O primeiro é transitório e a mídia continua; o segundo é definitivo
         * e nada do que o usuário faça nesta aba traz o slug de volta.
         * Colapsar os dois em `signaling-lost` fazia a tela dizer "servidor
         * fora do ar" para sempre depois que outra pessoa assumia o canal.
         */
        deps.channel.on('closed', ({ reason }) => {
          if (PERDA_DEFINITIVA.has(reason)) emitter.emit('closed', { reason });
          else emitter.emit('signaling-lost', undefined);
        }),
        /**
         * O canal voltou sozinho. Duas coisas nesta ordem:
         *
         * 1. Trocar as credenciais de ICE. As de TURN expiram, e um espectador
         *    novo entrando com credencial vencida falharia exatamente no
         *    cenário que a reconexão existe para consertar.
         * 2. Avisar a sessão, para o aviso de "servidor fora do ar" sumir.
         *
         * Os `peer-joined` que o servidor reapresenta caem no `admit`, que é
         * idempotente para link saudável — quem sobreviveu à queda continua.
         */
        deps.channel.on('reopened', (aberto) => {
          iceLifecycle?.use(aberto);
          emitter.emit('signaling-restored', undefined);
        }),
      );

      return { maxPeers: opened.maxPeers };
    },

    async watch(slug, identity) {
      const opened = await deps.channel.watch(slug, identity);
      const media = mediaStream();
      let delivered = false;
      const recovery = new PeerRecovery({
        scheduler: deps.scheduler,
        beforeRestart: () => iceLifecycle?.beforeRestart() ?? Promise.resolve(),
        mediaBytes: () => viewerLink?.mediaBytes('inbound') ?? Promise.resolve(null),
        restart: () => !viewerNeedsRebuild && (viewerLink?.restartIce() ?? false),
        rebuild: () => emitter.emit('closed', { reason: 'ICE_REBUILD' }),
        onRecovering: () => emitter.emit('reconnecting', undefined),
        onRecovered: () => {
          if (delivered && media.getVideoTracks().some((track) => !track.muted)) {
            emitter.emit('reconnected', undefined);
          }
        },
        onExhausted: () => emitter.emit('closed', { reason: 'ICE_FAILED' }),
      });
      recoveries.set('viewer', recovery);
      // Chega no `watching`, não como evento: quem acabou de entrar precisa do
      // número agora, e não só quando o próximo espectador mexer na contagem.
      queueMicrotask(() => emitter.emit('viewers', { count: opened.viewers }));

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
          link.setJitterAlvo(JITTER_INICIAL_MS);

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
            for (const old of media.getTracks()) {
              if (old !== track && old.kind === track.kind) media.removeTrack(old);
            }
            if (!media.getTracks().includes(track)) media.addTrack(track);
            if (track.kind === 'video') {
              delivered = true;
            }
            emitter.emit('track', { stream: media });
          };

          if (track.muted) track.addEventListener('unmute', anunciar, { once: true });
          else anunciar();

          if (track.kind !== 'video') return;

          /**
           * Fim da mídia, detectado pela própria mídia.
           *
           * Antes isso vinha do canal de sinalização — mas o canal e a mídia
           * são caminhos independentes, e é o argumento da arquitetura que
           * sejam. Depois de separar os dois eventos, o espectador deixou de
           * perceber o transmissor saindo quando o canal fechava primeiro:
           * ficava "assistindo" um vídeo congelado.
           *
           * A trilha remota emudece quando param de chegar pacotes. Uma
           * pausa curta acontece em toda reconexão de rede, então há uma
           * carência antes de declarar o fim.
           */
          track.addEventListener('ended', () => {
            if (media.getTracks().includes(track)) emitter.emit('closed', { reason: 'HOST_LEFT' });
          });

          let silencio: ReturnType<typeof setTimeout> | null = null;
          track.addEventListener('mute', () => {
            if (!media.getTracks().includes(track)) return;
            recovery.observe('disconnected');
            silencio ??= setTimeout(() => {
              if (track.muted && media.getTracks().includes(track)) recovery.observe('failed');
            }, MEDIA_GRACE_MS);
          });
          track.addEventListener('unmute', () => {
            if (!media.getTracks().includes(track)) return;
            const interrupted = silencio !== null;
            if (silencio !== null) {
              clearTimeout(silencio);
              silencio = null;
            }
            const recovering = recovery.recovering;
            recovery.observe('connected');
            if (interrupted && delivered && !recovering) emitter.emit('reconnected', undefined);
          });
        },
        onStateChange: (state) => {
          if (state === 'connected') emitter.emit('ice-conectado', undefined);
          recovery.observe(state);
        },
        onIssue: (code) => console.warn('[peer-link]', code),
        onFatal: (code) => {
          console.warn('[peer-link]', code);
          emitter.emit('closed', { reason: 'NEGOTIATION_FAILED' });
        },
      });
      viewerLink = link;
      iceLifecycle = new IceLifecycle(deps.channel, deps.scheduler, (lease) => {
        viewerNeedsRebuild = viewerLink?.updateIceServers(lease.iceServers) === false;
      });
      iceLifecycle.use(opened);

      unsubscribes.push(
        deps.channel.on('signal', ({ payload }) => {
          void link.handleSignal(payload).catch(() => {
            emitter.emit('closed', { reason: 'NEGOTIATION_FAILED' });
          });
        }),
        deps.channel.on('peer-left', () => emitter.emit('closed', { reason: 'HOST_LEFT' })),
        // Idem no espectador: perder o canal não é perder o vídeo.
        deps.channel.on('closed', () => emitter.emit('signaling-lost', undefined)),
        deps.channel.on('reopened', (aberto) => {
          iceLifecycle?.use(aberto);
          emitter.emit('signaling-restored', undefined);
        }),
        deps.channel.on('viewers', ({ count }) => emitter.emit('viewers', { count })),
      );
      return { relayStatus: opened.relayStatus ?? null };
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

    async replaceVideo(track) {
      const media = mediaStream();
      for (const antiga of media.getVideoTracks()) media.removeTrack(antiga);
      media.addTrack(track);
      await topology?.replaceVideo(track, media);
    },

    async setPrioridade(prioridade) {
      await topology?.setPrioridade(prioridade);
    },

    setJitterAlvo(ms) {
      viewerLink?.setJitterAlvo(ms);
    },

    async setUplinkBudget(bps) {
      await topology?.setOrcamento(bps);
    },

    async getAggregateStats(): Promise<MediaStats | null> {
      if (topology !== null) {
        // Uma coleta por peer, em paralelo, e o status de relay sai do mesmo
        // relatório — eram duas em série por segundo, por espectador.
        const reports = await topology.collectStats(isRelayed);
        if (reports.length === 0) return null;
        const stats = outbound.readMany(reports);
        if (stats === null || stats.audio === null) return stats;
        return {
          ...stats,
          audio: { ...stats.audio, configuracao: topology.resumoConfigAudio() },
        };
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
      iceLifecycle?.close();
      iceLifecycle = null;
      for (const recovery of recoveries.values()) recovery.close();
      recoveries.clear();
      for (const off of unsubscribes) off();
      unsubscribes.length = 0;
      topology?.close();
      topology = null;
      viewerLink?.close();
      viewerLink = null;
      viewerNeedsRebuild = false;
      stream = null;
      preset = null;
      deps.channel.close();
      emitter.clear();
    },
  };
}
