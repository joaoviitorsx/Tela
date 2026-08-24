import type { IceServerConfig } from '@tela/shared';
import { rtcConfiguration } from './ice-config.js';

/**
 * Uma conexão direta com um peer, negociada pelo padrão canônico do W3C
 * ("perfect negotiation").
 *
 * NÃO invente um handshake próprio aqui. Colisão de oferta acontece de
 * verdade neste produto: o transmissor publica o vídeo, o espectador entra, e
 * a trilha de áudio chega depois — `negotiationneeded` dispara dos dois lados
 * ao mesmo tempo. O padrão resolve isso com um único bit de assimetria.
 *
 * O transmissor é **impolite** (ignora ofertas que colidem com as dele) e o
 * espectador é **polite** (recua). Com os dois papéis fixados pela topologia,
 * nunca há empate.
 */
export type PeerLinkDeps = {
  readonly peerId: string;
  /** `true` para o lado que recua na colisão — o espectador. */
  readonly polite: boolean;
  readonly iceServers: readonly IceServerConfig[];
  /** Envia payload opaco para este peer. */
  readonly send: (payload: unknown) => void;
  /**
   * Fábrica injetada em vez de `new RTCPeerConnection` direto: `core/` precisa
   * rodar sem DOM (teste) e sob outro runtime na Fase 3 (Tauri).
   */
  readonly createConnection: (config: RTCConfiguration) => RTCPeerConnection;
  readonly onTrack?: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void;
  readonly onStateChange?: (state: RTCPeerConnectionState) => void;
};

/** O que trafega no `payload` opaco. O servidor nunca olha para isto (R8). */
export type SignalPayload = {
  readonly description?: RTCSessionDescriptionInit | null;
  readonly candidate?: RTCIceCandidateInit;
};

export class PeerLink {
  readonly peerId: string;
  private readonly pc: RTCPeerConnection;
  private readonly polite: boolean;
  private readonly send: (payload: unknown) => void;

  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;

  constructor(deps: PeerLinkDeps) {
    this.peerId = deps.peerId;
    this.polite = deps.polite;
    this.send = deps.send;
    this.pc = deps.createConnection(rtcConfiguration(deps.iceServers));

    this.pc.onnegotiationneeded = () => {
      void (async () => {
        try {
          this.makingOffer = true;
          await this.pc.setLocalDescription();
          if (this.closed) return;
          this.send({ description: this.pc.localDescription } satisfies SignalPayload);
        } catch {
          // Falha de negociação vira estado `failed` no `connectionstatechange`,
          // que é quem a topologia observa. Não há o que fazer aqui.
        } finally {
          this.makingOffer = false;
        }
      })();
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate !== null && !this.closed) {
        this.send({ candidate: candidate.toJSON() } satisfies SignalPayload);
      }
    };

    if (deps.onTrack !== undefined) {
      const onTrack = deps.onTrack;
      this.pc.ontrack = (event) => onTrack(event.track, event.streams);
    }

    if (deps.onStateChange !== undefined) {
      const onStateChange = deps.onStateChange;
      this.pc.onconnectionstatechange = () => onStateChange(this.pc.connectionState);
    }
  }

  get connection(): RTCPeerConnection {
    return this.pc;
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    const sender = this.pc.addTrack(track, stream);
    if (track.kind === 'video') this.preferVideoCodec(sender);
    return sender;
  }

  /**
   * Força H.264 na negociação deste peer.
   *
   * VP9 e AV1 comprimem melhor, mas o encode em software a 1080p60 come a CPU
   * que o jogo precisa. H.264 tem aceleração de hardware em qualquer GPU dos
   * últimos doze anos — é a única escolha compatível com "impacto no FPS do
   * jogo < 5%".
   */
  private preferVideoCodec(sender: RTCRtpSender): void {
    // `RTCRtpSender` é global de browser. `core/` roda em Node no teste e vai
    // rodar sob outro runtime na Fase 3 — checar só o método não basta, o
    // objeto inteiro pode não existir.
    if (typeof RTCRtpSender === 'undefined') return;
    if (typeof RTCRtpSender.getCapabilities !== 'function') return;
    const capabilities = RTCRtpSender.getCapabilities('video');
    if (capabilities === null) return;

    const transceiver = this.pc.getTransceivers().find((t) => t.sender === sender);
    if (transceiver === undefined || typeof transceiver.setCodecPreferences !== 'function') return;

    const wanted = 'video/h264';
    const preferred = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === wanted);
    if (preferred.length === 0) return;
    const rest = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() !== wanted);
    try {
      transceiver.setCodecPreferences([...preferred, ...rest]);
    } catch {
      // Navegador sem suporte a preferência de codec: o SDP negocia sozinho.
    }
  }

  /**
   * Mata o jitter buffer adaptativo dos receptores. Vale 50–100ms do orçamento
   * de latência — a diferença entre "dá pra jogar junto" e "dá pra assistir".
   * Só existe em Chromium; nos outros a atribuição é inócua.
   */
  minimizePlayoutDelay(): void {
    for (const receiver of this.pc.getReceivers()) {
      /**
       * Só no VÍDEO.
       *
       * Buffer de jitter zerado no áudio produz corte a cada oscilação de
       * rede — e áudio picotado é mais destrutivo que 100ms a mais de atraso,
       * que ninguém percebe numa call onde já se está conversando por outro
       * canal. A latência que este produto persegue é a da imagem.
       */
      if (receiver.track?.kind !== 'video') continue;

      const target = receiver as RTCRtpReceiver & {
        playoutDelayHint?: number;
        jitterBufferTarget?: number;
      };
      if ('playoutDelayHint' in target) target.playoutDelayHint = 0;
      if ('jitterBufferTarget' in target) target.jitterBufferTarget = 0;
    }
  }

  get senders(): RTCRtpSender[] {
    return this.pc.getSenders();
  }

  async handleSignal(payload: unknown): Promise<void> {
    if (this.closed) return;
    const { description, candidate } = (payload ?? {}) as SignalPayload;

    if (description !== undefined && description !== null) {
      const offerCollision =
        description.type === 'offer' &&
        (this.makingOffer || this.pc.signalingState !== 'stable');

      // O impolite ignora a oferta colidente e segue com a sua. O polite
      // aceita a do outro. Sem essa assimetria os dois lados recuam (ou
      // nenhum), e a negociação nunca converge.
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;

      await this.pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await this.pc.setLocalDescription();
        if (this.closed) return;
        this.send({ description: this.pc.localDescription } satisfies SignalPayload);
      }
      return;
    }

    if (candidate !== undefined) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        // Candidato que chega para uma oferta que decidimos ignorar é lixo
        // esperado. Qualquer outra falha é real e deve subir.
        if (!this.ignoreOffer) throw error;
      }
    }
  }

  async stats(): Promise<RTCStatsReport> {
    return await this.pc.getStats();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}
