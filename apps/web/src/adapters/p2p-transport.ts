import { DEGRADATION_PREFERENCE, type Connection, type IceCandidateInit } from '@tela/shared';
import { Emitter } from '../core/emitter.js';
import { StatsSampler } from '../core/media/stats-sampler.js';
import type {
  PublishRequest,
  PublisherEvents,
  PublisherTransport,
  TransportStats,
  ViewerEvents,
  ViewerTransport,
} from '../core/ports/media-transport.js';
import { minimizePlayoutDelay, preferH264 } from './rtc-codec.js';
import { type SignalSocket, openSignalSocket } from './signal-socket.js';

/**
 * Transporte P2P — o transmissor É o servidor.
 *
 * Topologia: uma RTCPeerConnection do transmissor para cada espectador. Não há
 * SFU no meio; o único componente central é o hub de sinalização, que troca
 * kilobytes de SDP e não vê mídia nenhuma. É isto que permite hospedar o
 * produto na própria rede: não existe egress de servidor para pagar.
 *
 * O preço, e ele é real:
 *
 * 1. **N encoders.** No browser, cada RTCPeerConnection codifica por conta
 *    própria — anexar a mesma track a três conexões roda três encoders 1080p60.
 *    É o mesmo argumento que proíbe três camadas de simulcast (R5), agora
 *    aplicado a espectadores. Por isso o teto é baixo e vem do servidor
 *    (`connection.maxViewers`), não daqui.
 *
 * 2. **N× o upstream.** O SFU replica no datacenter; aqui a réplica sai do
 *    link de casa, disputando banda com o netcode do próprio jogo.
 *
 * 3. **Sem simulcast.** E não faz falta: cada conexão tem um único receptor,
 *    então o controle de congestionamento dela já adapta o encoding àquele
 *    espectador. O amigo no 4G recebe menos sem estragar a imagem dos outros —
 *    o mesmo resultado que o simulcast dá no modo SFU, por outro caminho.
 *
 * Ver docs/adr/0002-transporte-p2p-self-host.md.
 */

function assertP2p(connection: Connection): Extract<Connection, { transport: 'p2p' }> {
  if (connection.transport !== 'p2p') throw new Error('conexão não é p2p');
  return connection;
}

/**
 * O formato do candidato no fio e o do browser são tipos diferentes: na spec
 * `candidate` é opcional e os campos nulos, no nosso protocolo `candidate` é
 * obrigatório. Converter explicitamente evita um `as any` que esconderia um
 * candidato malformado até a hora em que o ICE falha sem explicação.
 */
function candidateToWire(candidate: RTCIceCandidate): IceCandidateInit {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

function candidateFromWire(wire: IceCandidateInit): RTCIceCandidateInit {
  return {
    candidate: wire.candidate,
    sdpMid: wire.sdpMid ?? null,
    sdpMLineIndex: wire.sdpMLineIndex ?? null,
    usernameFragment: wire.usernameFragment ?? null,
  };
}

function toRtcConfig(connection: Extract<Connection, { transport: 'p2p' }>): RTCConfiguration {
  return {
    iceServers: connection.iceServers.map((server) => ({
      urls: server.urls,
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: server.credential } : {}),
    })),
    // `all` e não `relay`: o caminho direto é o objetivo. O TURN é a rede de
    // segurança para o usuário atrás de CGNAT, não o caminho preferencial.
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
  };
}

/* ───────────────────────────── publisher ───────────────────────────── */

type PeerLink = { pc: RTCPeerConnection; pending: IceCandidateInit[] };

export function makeP2pPublisherTransport(): PublisherTransport {
  const emitter = new Emitter<PublisherEvents>();
  const sampler = new StatsSampler('outbound');
  const peers = new Map<string, PeerLink>();

  let socket: SignalSocket | null = null;
  let config: RTCConfiguration = {};
  let request: PublishRequest | null = null;
  let closed = false;

  const announce = () => emitter.emit('viewers', peers.size);

  function dropPeer(id: string): void {
    const link = peers.get(id);
    if (!link) return;
    link.pc.close();
    peers.delete(id);
    announce();
  }

  async function offerTo(peerId: string): Promise<void> {
    if (request === null || socket === null) return;
    dropPeer(peerId); // renegociação de um espectador que reconectou

    const pc = new RTCPeerConnection(config);
    const link: PeerLink = { pc, pending: [] };
    peers.set(peerId, link);

    const sender = pc.addTransceiver(request.video, {
      direction: 'sendonly',
      sendEncodings: [
        {
          maxBitrate: request.maxBitrate,
          maxFramerate: request.maxFramerate,
          // Sem simulcast: um receptor por conexão. Ver o bloco no topo.
          scaleResolutionDownBy: 1,
        },
      ],
    });
    preferH264(sender);

    if (request.audio) {
      pc.addTransceiver(request.audio, { direction: 'sendonly' });
    }

    // Perder resolução, nunca framerate (R5). Fica em `parameters`, não na
    // encoding — é onde a spec atual coloca.
    const parameters = sender.sender.getParameters();
    try {
      await sender.sender.setParameters({
        ...parameters,
        degradationPreference: DEGRADATION_PREFERENCE,
      } as RTCRtpSendParameters);
    } catch {
      // Firefox ainda não aceita o campo. O encoding continua válido.
    }

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        socket?.send({ t: 'ice', to: peerId, candidate: candidateToWire(event.candidate) });
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(peerId);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (pc.localDescription) {
      socket.send({
        t: 'describe',
        to: peerId,
        sdp: { type: 'offer', sdp: pc.localDescription.sdp },
      });
    }
    announce();
  }

  return {
    async connect(connection) {
      const p2p = assertP2p(connection);
      config = toRtcConfig(p2p);

      socket = await openSignalSocket(p2p.signalUrl, p2p.ticket, {
        onMessage: (message) => {
          switch (message.t) {
            case 'peer-joined':
              void offerTo(message.peer);
              return;
            case 'peer-left':
              dropPeer(message.peer);
              return;
            case 'describe': {
              const link = peers.get(message.from);
              if (!link || message.sdp.type !== 'answer') return;
              void link.pc
                .setRemoteDescription({ type: 'answer', sdp: message.sdp.sdp })
                .then(async () => {
                  for (const candidate of link.pending) {
                    await link.pc.addIceCandidate(candidateFromWire(candidate));
                  }
                  link.pending = [];
                })
                .catch(() => dropPeer(message.from));
              return;
            }
            case 'ice': {
              const link = peers.get(message.from);
              if (!link) return;
              // Candidato que chega antes da answer precisa esperar: sem
              // remoteDescription, addIceCandidate lança.
              if (link.pc.remoteDescription === null) link.pending.push(message.candidate);
              else {
                void link.pc
                  .addIceCandidate(candidateFromWire(message.candidate))
                  .catch(() => undefined);
              }
              return;
            }
            default:
              return;
          }
        },
        onClose: () => {
          if (closed) return;
          emitter.emit('closed', { reason: 'SIGNAL_CLOSED' });
        },
      });
    },

    async publish(next) {
      request = next;
      // Republicar (troca de preset) renegocia com todo mundo.
      for (const peerId of [...peers.keys()]) await offerTo(peerId);
    },

    async readStats(): Promise<TransportStats | null> {
      if (peers.size === 0) return null;
      // Um report por espectador, somados: o número que interessa ao usuário
      // é quanto está saindo do link dele no total.
      const reports = await Promise.all([...peers.values()].map((link) => link.pc.getStats()));
      const merged = new Map<string, unknown>();
      for (const report of reports) {
        report.forEach((entry, key) => merged.set(`${merged.size}:${key}`, entry));
      }
      return sampler.read(merged as unknown as RTCStatsReport);
    },

    on(event, handler) {
      return emitter.on(event, handler);
    },

    async close() {
      closed = true;
      for (const link of peers.values()) link.pc.close();
      peers.clear();
      socket?.send({ t: 'bye' });
      socket?.close();
      socket = null;
      emitter.clear();
    },
  };
}

/* ───────────────────────────── viewer ───────────────────────────── */

export function makeP2pViewerTransport(): ViewerTransport {
  const emitter = new Emitter<ViewerEvents>();
  const sampler = new StatsSampler('inbound');
  const stream = new MediaStream();

  let pc: RTCPeerConnection | null = null;
  let socket: SignalSocket | null = null;
  let pending: IceCandidateInit[] = [];
  let closed = false;

  return {
    async connect(connection, sink) {
      const p2p = assertP2p(connection);
      const config = toRtcConfig(p2p);

      await new Promise<void>((resolve, reject) => {
        let delivered = false;

        const ensurePc = (): RTCPeerConnection => {
          if (pc !== null) return pc;
          const created = new RTCPeerConnection(config);
          pc = created;

          created.addEventListener('track', (event) => {
            stream.addTrack(event.track);
            minimizePlayoutDelay(event.receiver);
            if (!delivered && event.track.kind === 'video') {
              delivered = true;
              sink(stream);
              emitter.emit('track', { hasAudio: stream.getAudioTracks().length > 0 });
              resolve();
            }
          });

          created.addEventListener('icecandidate', (event) => {
            if (event.candidate) {
              socket?.send({ t: 'ice', candidate: candidateToWire(event.candidate) });
            }
          });

          created.addEventListener('connectionstatechange', () => {
            if (created.connectionState === 'failed') {
              emitter.emit('closed', { reason: 'ICE_FAILED' });
            }
          });

          return created;
        };

        openSignalSocket(p2p.signalUrl, p2p.ticket, {
          onMessage: (message) => {
            if (message.t === 'describe' && message.sdp.type === 'offer') {
              const peer = ensurePc();
              void (async () => {
                await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp.sdp });
                for (const candidate of pending) {
                  await peer.addIceCandidate(candidateFromWire(candidate));
                }
                pending = [];
                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);
                if (peer.localDescription) {
                  socket?.send({
                    t: 'describe',
                    sdp: { type: 'answer', sdp: peer.localDescription.sdp },
                  });
                }
              })().catch(() => reject(new Error('NEGOTIATION_FAILED')));
              return;
            }

            if (message.t === 'ice') {
              const peer = pc;
              if (peer === null || peer.remoteDescription === null) {
                pending.push(message.candidate);
              } else {
                void peer
                  .addIceCandidate(candidateFromWire(message.candidate))
                  .catch(() => undefined);
              }
              return;
            }

            if (message.t === 'peer-left') {
              emitter.emit('closed', { reason: 'PUBLISHER_LEFT' });
            }
          },
          onClose: () => {
            if (closed) return;
            if (!delivered) reject(new Error('SIGNAL_CLOSED'));
            emitter.emit('closed', { reason: 'SIGNAL_CLOSED' });
          },
        })
          .then((opened) => {
            socket = opened;
          })
          .catch(reject);
      });
    },

    async readStats() {
      if (pc === null) return null;
      return sampler.read(await pc.getStats());
    },

    on(event, handler) {
      return emitter.on(event, handler);
    },

    async close() {
      closed = true;
      pc?.close();
      pc = null;
      socket?.send({ t: 'bye' });
      socket?.close();
      socket = null;
      for (const track of stream.getTracks()) stream.removeTrack(track);
      emitter.clear();
    },
  };
}
