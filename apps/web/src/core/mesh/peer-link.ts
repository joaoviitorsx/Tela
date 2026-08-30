import type { IceServerConfig } from '@tela/shared';
import { rtcConfiguration } from './ice-config.js';
import { afinarSdp } from './sdp-tuning.js';

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
  /**
   * Por onde o encoder deve começar, em bits/s. Consultado a cada descrição
   * recebida porque o alvo muda com o degrau e com o teto de upload.
   *
   * Ausente no espectador, que não manda vídeo.
   */
  readonly startBitrateBps?: () => number | null;
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
  private readonly startBitrateBps: (() => number | null) | null;

  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;

  constructor(deps: PeerLinkDeps) {
    this.peerId = deps.peerId;
    this.polite = deps.polite;
    this.send = deps.send;
    this.startBitrateBps = deps.startBitrateBps ?? null;
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
      transceiver.setCodecPreferences([...ordenarH264(preferred), ...rest]);
    } catch {
      // Navegador sem suporte a preferência de codec: o SDP negocia sozinho.
    }
  }

  /**
   * Ajusta o jitter buffer dos receptores de vídeo.
   *
   * # Por que é ajustável e não uma constante
   *
   * Era ZERO nos dois campos, o que não é "buffer pequeno": é buffer NENHUM.
   * Todo pacote fora de ordem ou atrasado — o que acontece em qualquer Wi-Fi —
   * era descartado, o quadro ficava incompleto, o decoder pedia keyframe, e
   * keyframe custa de 6 a 10 vezes um quadro normal (medido e publicado pelo
   * Discord). O resultado era pulso de nitidez e mancha, com cadência
   * irregular que se lê como travamento mesmo com 58ms de RTT.
   *
   * Passou para 80ms fixos, e isso consertou a cadência — mas cobrou 80ms de
   * TODA conexão, inclusive das calmas, que não precisavam. Um usuário relatou
   * cerca de um segundo de atraso; 80ms não explicam um segundo, mas latência
   * paga sem necessidade é latência paga sem necessidade.
   *
   * Agora o alvo é dirigido pela sessão a partir do que ela mede — congelamento
   * e perda. Rápido para subir, devagar para descer, que é a mesma disciplina
   * da escada de qualidade: uma malha que reage mais rápido do que o sistema
   * assenta oscila.
   *
   * `jitterBufferTarget` é um PISO, não um alvo fixo: o buffer real é
   * `max(alvo, o que o estimador de jitter calcular)`. Ele só custa latência
   * quando a rede está calma — que é exatamente quando ela sobra.
   *
   * Só existe em Chromium; nos outros a atribuição é inócua.
   */
  setJitterAlvo(ms: number): void {
    for (const receiver of this.pc.getReceivers()) {
      /**
       * Só no VÍDEO.
       *
       * Buffer de jitter curto no áudio produz corte a cada oscilação de rede,
       * e áudio picotado é mais destrutivo que 100ms a mais de atraso, que
       * ninguém percebe numa call onde já se está conversando por outro canal.
       * A latência que este produto persegue é a da imagem.
       */
      if (receiver.track?.kind !== 'video') continue;

      const target = receiver as RTCRtpReceiver & {
        playoutDelayHint?: number;
        jitterBufferTarget?: number;
      };
      if ('playoutDelayHint' in target) target.playoutDelayHint = ms / 1000;
      if ('jitterBufferTarget' in target) target.jitterBufferTarget = ms;
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

      await this.pc.setRemoteDescription(this.afinar(description));
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
      } catch {
        /**
         * Candidato que falha é ENGOLIDO, sempre. Antes ele subia.
         *
         * A regra era "candidato de uma oferta ignorada é lixo esperado;
         * qualquer outra falha é real e deve subir". Mas "subir" aqui não é um
         * log — a topologia faz `catch { this.drop(from) }` e o espectador faz
         * `closed: NEGOTIATION_FAILED`. Ou seja: um candidato que o Chrome
         * recusa parsear, um `sdpMid` de seção que o `max-bundle` derrubou, ou
         * um candidato que chega fora de ordem MATA a conexão inteira.
         *
         * A assimetria de custo decide: perder um candidato degrada o ICE — há
         * outros, e o par vencedor raramente é o primeiro. Derrubar o peer
         * termina a sessão daquele espectador.
         */
      }
    }
  }

  /**
   * Ajusta o SDP recebido antes de aplicá-lo. Ver `sdp-tuning.ts`.
   *
   * Falhar aqui não pode derrubar a negociação: um SDP que não casa com
   * nenhum dos padrões simplesmente passa intacto, e a conexão fica como
   * estava antes desta afinação existir.
   */
  private afinar(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    if (typeof description.sdp !== 'string') return description;
    try {
      const sdp = afinarSdp(description.sdp, {
        startBitrateBps: this.startBitrateBps?.() ?? null,
      });
      return sdp === description.sdp ? description : { type: description.type, sdp };
    } catch {
      return description;
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

/**
 * Alvo do jitter buffer do espectador, em milissegundos.
 *
 * Era zero. Ver `setJitterAlvo` para por que zero era pior que 80.
 */
export const JITTER_INICIAL_MS = 80;

/**
 * O menor buffer que ainda vale tentar.
 *
 * Abaixo disto o ganho de latência é pequeno e o risco de voltar ao ciclo de
 * keyframe é grande — 40ms é menos de três quadros a 60fps.
 */
export const JITTER_MINIMO_MS = 40;

/** O maior. Acima disto o produto deixa de ser tempo real. */
export const JITTER_MAXIMO_MS = 240;

/**
 * Ordena as variantes de H.264 da melhor para a pior. Grátis em banda.
 *
 * `setCodecPreferences` respeita a ordem que recebe, e a versão anterior
 * filtrava só por `mimeType` — herdando a ordem do navegador, que põe
 * **Constrained Baseline** (`42…`) primeiro. Baseline não tem CABAC nem
 * transformada 8×8: são 10 a 15% de bitrate a mais para a MESMA imagem. Num
 * orçamento de 3 Mbps por espectador, 15% é um degrau inteiro da escada.
 *
 * Dois critérios, nesta ordem:
 *
 * 1. **`packetization-mode=1`** antes de `0`. O modo 0 aceita um NAL por
 *    pacote e proíbe fragmentação, o que em 1080p força o encoder a picotar o
 *    quadro em fatias pequenas — mais overhead, pior compressão, e uma perda
 *    de pacote custando mais imagem.
 * 2. **Perfil**: High (`64`) > Main (`4d`) > Baseline (`42`). Todos os
 *    encoders de hardware dos últimos doze anos fazem High; é a mesma
 *    aceleração, com um codificador de entropia melhor.
 *
 * O nível anunciado NÃO entra aqui: o Chromium oferece `1f` (3.1) em todas as
 * variantes, então não há o que preferir. Ele é corrigido na entrada, em
 * `sdp-tuning.ts`.
 */
export function ordenarH264(
  codecs: readonly RTCRtpCodec[],
): RTCRtpCodec[] {
  return [...codecs].sort((a, b) => nota(b) - nota(a));
}

function nota(codec: RTCRtpCodec): number {
  const fmtp = (codec.sdpFmtpLine ?? '').toLowerCase();
  const modo = fmtp.includes('packetization-mode=1') ? 100 : 0;

  const perfil = /profile-level-id=([0-9a-f]{2})/.exec(fmtp)?.[1];
  const porPerfil: Record<string, number> = { '64': 10, '4d': 5, '42': 1 };
  return modo + (perfil === undefined ? 0 : (porPerfil[perfil] ?? 0));
}
