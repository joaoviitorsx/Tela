import { type IceServerConfig, TETO_DA_SONDA_BPS } from '@tela/shared';
import type { ReferenciaDeCaptura } from '../media/relogio-de-captura.js';
import { rtcConfiguration } from './ice-config.js';
import { afinarSdp, pedirEstereo } from './sdp-tuning.js';

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
  /** Códigos fixos; SDP, IP e candidato nunca entram no diagnóstico. */
  readonly onIssue?: (code: PeerLinkIssueCode) => void;
  readonly onFatal?: (code: PeerLinkFatalCode) => void;
  readonly now?: () => number;
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
  readonly candidate?: RTCIceCandidateInit | null;
  /** Ufrag da geração ICE, ou identidade local quando o SDP ainda não a expõe. */
  readonly generation?: string;
};

export type PeerLinkIssueCode =
  | 'SIGNAL_INVALID' | 'CANDIDATE_REJECTED' | 'CANDIDATE_STALE'
  | 'CANDIDATE_QUEUE_FULL' | 'CANDIDATE_EXPIRED' | 'CANDIDATE_AMBIGUOUS'
  | 'ICE_CONFIGURATION_FAILED' | 'ICE_RESTART_UNAVAILABLE';
export type PeerLinkFatalCode = 'LOCAL_DESCRIPTION_FAILED' | 'REMOTE_DESCRIPTION_FAILED' | 'NEGOTIATION_QUEUE_FULL';

const URI_CAPTURA_ABSOLUTA = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';

/** `captureTimestamp` ainda não está no `lib.dom` do TypeScript. */
type ExtensaoDeCabecalho = {
  readonly uri: string;
  readonly direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'stopped';
};
/** `setHeaderExtensionsToNegotiate` também falta no `lib.dom`. */
type TransceiverComExtensoes = RTCRtpTransceiver & {
  getHeaderExtensionsToNegotiate?: () => readonly ExtensaoDeCabecalho[];
  setHeaderExtensionsToNegotiate?: (e: readonly ExtensaoDeCabecalho[]) => void;
};
type FonteComCaptura = RTCRtpSynchronizationSource & { readonly captureTimestamp?: number };

export class PeerLinkError extends Error {
  constructor(readonly code: PeerLinkFatalCode) { super(code); }
}

const MAX_OPERATIONS = 64;
const MAX_CANDIDATES = 64;
const CANDIDATE_TTL_MS = 15_000;
let nextLinkGeneration = 0;

function sdpUfrag(sdp: string | undefined): string | null {
  return sdp === undefined ? null : (/^a=ice-ufrag:([^\s\r\n]+)/m.exec(sdp)?.[1] ?? null);
}

function sdpUfrags(sdp: string | undefined): Set<string> {
  const values = new Set<string>();
  if (sdp !== undefined) {
    for (const match of sdp.matchAll(/^a=ice-ufrag:([^\s\r\n]+)/gm)) {
      if (match[1] !== undefined) values.add(match[1]);
    }
  }
  return values;
}

type PendingCandidate = {
  candidate: RTCIceCandidateInit;
  generation: string | null;
  fromUfrag: boolean;
  receivedAt: number;
};

export class PeerLink {
  readonly peerId: string;
  private readonly pc: RTCPeerConnection;
  private readonly polite: boolean;
  private readonly send: (payload: unknown) => void;
  private readonly startBitrateBps: (() => number | null) | null;
  private readonly onIssue: (code: PeerLinkIssueCode) => void;
  private readonly onFatal: (code: PeerLinkFatalCode) => void;
  private readonly now: () => number;
  private readonly linkGeneration = `link-${++nextLinkGeneration}`;
  private localGeneration = this.linkGeneration;
  private remoteGeneration: string | null = null;
  private remoteIceUfrags = new Set<string>();
  private remoteGenerationsSeen = 0;
  private readonly staleGenerations = new Set<string>();
  private ignoredGeneration: string | null = null;
  private readonly pendingCandidates: PendingCandidate[] = [];
  private operationTail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;
  private localNegotiationQueued = false;
  private needsRenegotiation = false;

  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;

  constructor(deps: PeerLinkDeps) {
    this.peerId = deps.peerId;
    this.polite = deps.polite;
    this.send = deps.send;
    this.startBitrateBps = deps.startBitrateBps ?? null;
    this.onIssue = deps.onIssue ?? (() => undefined);
    this.onFatal = deps.onFatal ?? (() => undefined);
    this.now = deps.now ?? Date.now;
    this.pc = deps.createConnection(rtcConfiguration(deps.iceServers));

    this.pc.onnegotiationneeded = () => {
      this.requestNegotiation();
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (this.closed) return;
      const init: RTCIceCandidateInit = candidate?.toJSON() ?? { candidate: '' };
      // O evento pode chegar antes de setLocalDescription() resolver. A
      // descrição já costuma estar disponível na PC nesse instante.
      const localUfrags = sdpUfrags(this.pc.localDescription?.sdp);
      const candidateUfrag = init.usernameFragment;
      const generation = candidateUfrag != null && !localUfrags.has(candidateUfrag)
        ? candidateUfrag : sdpUfrag(this.pc.localDescription?.sdp) ?? this.localGeneration;
      this.localGeneration = sdpUfrag(this.pc.localDescription?.sdp) ?? generation;
      this.send({ candidate: init, generation } satisfies SignalPayload);
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
    if (track.kind === 'video') {
      this.preferVideoCodec(sender);
      this.negociarCapturaAbsoluta(sender);
    }
    return sender;
  }

  /**
   * Liga a extensão `abs-capture-time` neste sender.
   *
   * O Chromium a lista como `stopped`: sem pedir, o SDP não a traz e o
   * espectador não tem como saber QUANDO o quadro foi capturado. Não é
   * munging — é a API `setHeaderExtensionsToNegotiate`, e o espectador (que
   * responde) a aceita sem configuração.
   *
   * Não toca nenhuma das quatro configurações da R5: é um cabeçalho de 8 bytes
   * por quadro, não encoding. Idêntico em todos os peers, então não quebra o
   * reaproveitamento do encoder.
   */
  private negociarCapturaAbsoluta(sender: RTCRtpSender): void {
    const t = this.pc.getTransceivers().find((x) => x.sender === sender) as
      | TransceiverComExtensoes
      | undefined;
    if (
      t === undefined ||
      typeof t.getHeaderExtensionsToNegotiate !== 'function' ||
      typeof t.setHeaderExtensionsToNegotiate !== 'function'
    ) {
      return;
    }
    try {
      t.setHeaderExtensionsToNegotiate(
        t.getHeaderExtensionsToNegotiate().map((e) =>
          e.uri === URI_CAPTURA_ABSOLUTA ? { uri: e.uri, direction: 'sendrecv' as const } : e,
        ),
      );
    } catch {
      // Navegador sem a API (ou que a recusa): a latência cai para `recepcao`.
    }
  }

  /**
   * Instante de captura do pacote de vídeo mais recente, no relógio do
   * transmissor, e o último Sender Report. Ver `RelogioDeCaptura`.
   *
   * `rVFC.captureTime` não serve: o Chromium não o preenche para vídeo remoto.
   * O mesmo dado sai de `getSynchronizationSources()`.
   */
  async referenciaDeCaptura(): Promise<ReferenciaDeCaptura | null> {
    if (this.closed) return null;
    try {
      const rx = this.pc.getReceivers().find((r) => r.track.kind === 'video');
      if (rx === undefined) return null;
      const fontes = rx.getSynchronizationSources() as readonly FonteComCaptura[];
      const fonte = fontes.find((f) => typeof f.captureTimestamp === 'number');
      if (fonte?.captureTimestamp === undefined) return null;

      let sr: { remotoMs: number; recebidoMs: number } | null = null;
      let rttMs = 0;
      const report = await this.pc.getStats();
      report.forEach((entry) => {
        const row = entry as {
          type?: string;
          kind?: string;
          timestamp?: number;
          remoteTimestamp?: number;
          nominated?: boolean;
          state?: string;
          currentRoundTripTime?: number;
        };
        if (row.type === 'candidate-pair' && row.nominated === true) {
          if (typeof row.currentRoundTripTime === 'number') rttMs = row.currentRoundTripTime * 1000;
        } else if (
          row.type === 'remote-outbound-rtp' &&
          row.kind === 'video' &&
          typeof row.timestamp === 'number' &&
          typeof row.remoteTimestamp === 'number'
        ) {
          sr = { remotoMs: row.remoteTimestamp, recebidoMs: row.timestamp };
        }
      });
      // `timestamp` da fonte: Unix em ms no Chromium; relativo à origem da
      // página em outros. Os dois viram Unix.
      const entregueMs = fonte.timestamp > 1e12 ? fonte.timestamp : performance.timeOrigin + fonte.timestamp;
      return {
        rtpTimestamp: fonte.rtpTimestamp,
        captureTimestamp: fonte.captureTimestamp,
        entregueMs,
        relogio: sr === null ? null : { ...(sr as { remotoMs: number; recebidoMs: number }), rttMs },
      };
    } catch {
      return null;
    }
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

    const preferencias = preferenciasDeVideo(capabilities.codecs);
    if (preferencias === null) return;
    try {
      transceiver.setCodecPreferences(preferencias);
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
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      this.onIssue('SIGNAL_INVALID');
      return;
    }
    const signal = payload as SignalPayload;
    const generation = typeof signal.generation === 'string' && signal.generation.length <= 128
      ? signal.generation : null;
    if (signal.description !== undefined && signal.description !== null) {
      const description = signal.description;
      if (description.type !== 'offer' && description.type !== 'answer') {
        this.onIssue('SIGNAL_INVALID');
        return;
      }
      await this.enqueue(() => this.receiveDescription(description, generation));
      return;
    }
    if (signal.candidate !== undefined) {
      const candidate = signal.candidate ?? { candidate: '' };
      if (typeof candidate !== 'object' || typeof candidate.candidate !== 'string') {
        this.onIssue('SIGNAL_INVALID');
        return;
      }
      if (this.pendingOperations >= MAX_OPERATIONS) {
        this.onIssue('CANDIDATE_QUEUE_FULL');
        return;
      }
      await this.enqueue(() => this.receiveCandidate(
        candidate,
        generation ?? candidate.usernameFragment ?? null,
        generation === null && candidate.usernameFragment !== undefined,
      ));
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pendingOperations >= MAX_OPERATIONS) {
      return Promise.reject(new PeerLinkError('NEGOTIATION_QUEUE_FULL'));
    }
    this.pendingOperations += 1;
    const run = this.operationTail.then(async () => {
      if (!this.closed) await task();
    });
    this.operationTail = run.catch(() => undefined);
    return run.finally(() => { this.pendingOperations -= 1; });
  }

  private sendLocalDescription(): void {
    const description = this.pc.localDescription;
    if (description === null) return;
    this.localGeneration = sdpUfrag(description.sdp) ?? this.localGeneration;
    this.send({ description, generation: this.localGeneration } satisfies SignalPayload);
  }

  private requestNegotiation(): void {
    if (this.closed) return;
    if (this.localNegotiationQueued) {
      if (this.makingOffer) this.needsRenegotiation = true;
      return;
    }
    if (this.pc.signalingState !== 'stable') {
      this.needsRenegotiation = true;
      return;
    }
    this.localNegotiationQueued = true;
    void this.enqueue(async () => {
      try {
        if (this.pc.signalingState !== 'stable') {
          this.needsRenegotiation = true;
          return;
        }
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (!this.closed) this.sendLocalDescription();
      } catch {
        if (!this.closed) this.onFatal('LOCAL_DESCRIPTION_FAILED');
      } finally {
        this.makingOffer = false;
        this.localNegotiationQueued = false;
      }
    }).catch(() => {
      this.localNegotiationQueued = false;
      if (!this.closed) this.onFatal('NEGOTIATION_QUEUE_FULL');
    });
  }

  private async receiveDescription(description: RTCSessionDescriptionInit, signaledGeneration: string | null): Promise<void> {
    const generation = signaledGeneration ?? sdpUfrag(description.sdp);
    // A fila serial elimina a janela entre `isSettingRemoteAnswerPending` e
    // `setRemoteDescription` do exemplo canônico: só uma operação toca a PC.
    const offerCollision = description.type === 'offer' &&
      (this.makingOffer || this.pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) {
      this.ignoredGeneration = generation;
      if (generation !== null) this.markStale(generation);
      for (const ufrag of sdpUfrags(description.sdp)) this.markStale(ufrag);
      return;
    }
    this.ignoredGeneration = null;
    try {
      await this.pc.setRemoteDescription(this.afinar(description));
    } catch {
      if (!this.closed) throw new PeerLinkError('REMOTE_DESCRIPTION_FAILED');
      return;
    }
    if (this.closed) return;
    try {
      const newUfrags = sdpUfrags(description.sdp);
      if (generation !== this.remoteGeneration) {
        if (this.remoteGeneration !== null) {
          this.markStale(this.remoteGeneration);
        }
        for (const ufrag of this.remoteIceUfrags) {
          if (!newUfrags.has(ufrag)) this.markStale(ufrag);
        }
        this.remoteGeneration = generation;
        this.remoteGenerationsSeen += 1;
      } else if (this.remoteGenerationsSeen === 0) {
        this.remoteGenerationsSeen = 1;
      }
      this.remoteIceUfrags = newUfrags;
      if (generation !== null) this.staleGenerations.delete(generation);
      for (const ufrag of newUfrags) this.staleGenerations.delete(ufrag);
      await this.flushCandidates();
      if (this.closed) return;
      if (description.type === 'offer') {
        await this.responder();
        if (!this.closed) this.sendLocalDescription();
      }
      if (this.pc.signalingState === 'stable' && this.needsRenegotiation) {
        this.needsRenegotiation = false;
        this.requestNegotiation();
      }
    } catch {
      if (!this.closed) throw new PeerLinkError('LOCAL_DESCRIPTION_FAILED');
    }
  }

  /**
   * A resposta, com a preferência de estéreo do receptor (TELA-011). Ver
   * `pedirEstereo`: sem isto o espectador decodificava em mono o que o
   * transmissor mandava em estéreo.
   *
   * `createAnswer` explícito em vez de `setLocalDescription()` sem argumento:
   * o perfect negotiation continua o mesmo — quem responde é sempre quem
   * recebeu a oferta, na mesma fila serial —, só que a resposta passa por
   * uma edição de `fmtp` antes de valer. Se o navegador recusar a edição,
   * cai para a resposta intacta: mono é pior que estéreo, sem áudio é pior
   * que mono.
   */
  private async responder(): Promise<void> {
    const resposta = await this.pc.createAnswer();
    if (typeof resposta.sdp !== 'string') {
      await this.pc.setLocalDescription(resposta);
      return;
    }
    const comEstereo = pedirEstereo(resposta.sdp);
    try {
      await this.pc.setLocalDescription({ type: resposta.type, sdp: comEstereo });
    } catch {
      if (comEstereo === resposta.sdp) throw new Error('LOCAL_DESCRIPTION_FAILED');
      await this.pc.setLocalDescription(resposta);
    }
  }

  private markStale(generation: string): void {
    this.staleGenerations.add(generation);
    if (this.staleGenerations.size > 4) {
      const oldest = this.staleGenerations.values().next().value;
      if (oldest !== undefined) this.staleGenerations.delete(oldest);
    }
  }

  private matchesRemote(generation: string | null, fromUfrag: boolean): boolean {
    return generation === null || generation === this.remoteGeneration ||
      (fromUfrag && this.remoteIceUfrags.has(generation));
  }

  private async receiveCandidate(candidate: RTCIceCandidateInit, generation: string | null, fromUfrag: boolean): Promise<void> {
    if (this.ignoreOffer && (generation === null || generation === this.ignoredGeneration)) {
      this.onIssue('CANDIDATE_STALE');
      return;
    }
    if (generation !== null && this.staleGenerations.has(generation)) {
      this.onIssue('CANDIDATE_STALE');
      return;
    }
    if (this.pc.remoteDescription === null ||
      (this.remoteGeneration !== null && !this.matchesRemote(generation, fromUfrag))) {
      this.queueCandidate(candidate, generation, fromUfrag);
      return;
    }
    if (generation === null && this.remoteGenerationsSeen > 1) {
      this.onIssue('CANDIDATE_AMBIGUOUS');
      return;
    }
    await this.applyCandidate(candidate);
  }

  private queueCandidate(candidate: RTCIceCandidateInit, generation: string | null, fromUfrag: boolean): void {
    this.expireCandidates();
    if (this.pendingCandidates.length >= MAX_CANDIDATES) {
      this.pendingCandidates.shift();
      this.onIssue('CANDIDATE_QUEUE_FULL');
    }
    this.pendingCandidates.push({ candidate, generation, fromUfrag, receivedAt: this.now() });
  }

  private expireCandidates(): void {
    const cutoff = this.now() - CANDIDATE_TTL_MS;
    while (this.pendingCandidates[0] !== undefined && this.pendingCandidates[0].receivedAt < cutoff) {
      this.pendingCandidates.shift();
      this.onIssue('CANDIDATE_EXPIRED');
    }
  }

  private async flushCandidates(): Promise<void> {
    this.expireCandidates();
    const pending = this.pendingCandidates.splice(0);
    for (const item of pending) {
      if (this.closed) return;
      if (item.generation !== null && this.remoteGeneration !== null && !this.matchesRemote(item.generation, item.fromUfrag)) {
        this.onIssue('CANDIDATE_STALE');
      } else if (item.generation === null && this.remoteGenerationsSeen > 1) {
        this.onIssue('CANDIDATE_AMBIGUOUS');
      } else {
        await this.applyCandidate(item.candidate);
      }
    }
  }

  private async applyCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // Um candidato isolado pode falhar sem encerrar os outros caminhos ICE.
      if (!this.closed) this.onIssue('CANDIDATE_REJECTED');
    }
  }

  /** Troca só os servidores; opções imutáveis da PC permanecem intactas. */
  updateIceServers(servers: readonly IceServerConfig[]): boolean {
    if (this.closed) return false;
    try {
      this.pc.setConfiguration({
        ...this.pc.getConfiguration(),
        iceServers: rtcConfiguration(servers).iceServers ?? [],
      });
      return true;
    } catch {
      this.onIssue('ICE_CONFIGURATION_FAILED');
      return false;
    }
  }

  /** Entra na mesma fila de ofertas; nunca cria uma negociação paralela. */
  restartIce(): boolean {
    if (this.closed || typeof this.pc.restartIce !== 'function') {
      if (!this.closed) this.onIssue('ICE_RESTART_UNAVAILABLE');
      return false;
    }
    try {
      this.pc.restartIce();
      this.requestNegotiation();
      return true;
    } catch {
      this.onIssue('ICE_RESTART_UNAVAILABLE');
      return false;
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
        // Só em quem envia (quem tem início): 1,5 × o teto da escada (ver a constante).
        maxBitrateBps: this.startBitrateBps === null ? null : TETO_DA_SONDA_BPS,
      });
      return sdp === description.sdp ? description : { type: description.type, sdp };
    } catch {
      return description;
    }
  }

  async stats(): Promise<RTCStatsReport> {
    return await this.pc.getStats();
  }

  async mediaBytes(direction: 'inbound' | 'outbound'): Promise<number | null> {
    if (this.closed) return null;
    try {
      const report = await this.pc.getStats();
      let total = 0;
      let found = false;
      report.forEach((entry) => {
        const row = entry as { type?: string; kind?: string; bytesReceived?: number; bytesSent?: number };
        if (row.type !== `${direction}-rtp` || row.kind !== 'video') return;
        const bytes = direction === 'inbound' ? row.bytesReceived : row.bytesSent;
        if (typeof bytes !== 'number') return;
        total += bytes;
        found = true;
      });
      return found ? total : null;
    } catch { return null; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.needsRenegotiation = false;
    this.pendingCandidates.length = 0;
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
/**
 * Por onde o buffer começa, antes de o governador medir qualquer coisa.
 *
 * Era 80ms, escolhido por intuição. O número calibrado veio depois, e é
 * medido: Carrascosa & Bellalta instrumentaram o **Stadia** (arXiv:2009.09786,
 * Computer Communications 188/2022) e mediram o jitter buffer dele em
 *
 *     720p  58,42 ms      1080p  45,34 ms      4K  35,35 ms
 *
 * Dois a três quadros, e ENCOLHENDO conforme a resolução sobe. E o Stadia é
 * WebRTC quase de estoque — "no substantial modifications", por Di Domenico et
 * al. (arXiv:2012.06774) — o que faz dele o comparável mais direto que existe
 * para este produto.
 *
 * 60ms fica acima dos 45 deles, porque eles saem de datacenter e nós saímos do
 * link doméstico de alguém. Mas os 80 não tinham defesa: eram 1,8× o medido, e
 * latência paga sem evidência é latência jogada fora. O governador sobe na
 * primeira travada se este valor for otimista demais.
 */
export const JITTER_INICIAL_MS = 60;

/**
 * O menor buffer que ainda vale tentar.
 *
 * Abaixo disto o ganho de latência é pequeno e o risco de voltar ao ciclo de
 * keyframe é grande — 40ms é menos de três quadros a 60fps.
 *
 * E o número caiu em cima do medido por acidente: o Stadia opera 1080p em
 * 45,34 ms. Nosso piso é praticamente o regime dele.
 */
export const JITTER_MINIMO_MS = 40;

/**
 * O maior. Acima disto o produto deixa de ser tempo real.
 *
 * O MQP do WPI (Claypool, abr/2024) mediu esta troca no Moonlight com jitter
 * injetado por `tc-netem`: uma fila de 2 quadros (+33 ms) já cortou pela metade
 * a magnitude do jitter em cenário baixo e médio, e só o jitter extremo — 100 ms
 * de magnitude, dez vezes por segundo — precisou de 10 quadros (+167 ms).
 *
 * 240 é mais do que o pior caso medido por eles precisou, então este teto não é
 * a restrição que morde. A velocidade de descida é.
 */
export const JITTER_MAXIMO_MS = 240;

/**
 * Fora das preferências de VÍDEO (estudo 2 · T5): no libwebrtc a RED de vídeo
 * é só o invólucro do ULPFEC, que já vem desligado para H.264 com NACK, e o
 * FlexFEC exige *field trial* nas duas pontas — o espectador é um navegador
 * qualquer. Tirar os três não muda um bit no fio e tira a ambiguidade do
 * SDP. O `rtx` fica: é ele que faz o NACK reenviar. A RED do ÁUDIO (Opus,
 * redundância de verdade) não passa por aqui.
 */
export const SEM_FEC_NO_VIDEO: ReadonlySet<string> = new Set(['video/red', 'video/ulpfec', 'video/flexfec-03']);

/** A lista do `setCodecPreferences` do vídeo: H.264 ordenado na frente, o resto sem FEC. `null` sem H.264. */
export function preferenciasDeVideo(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] | null {
  const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  if (h264.length === 0) return null;
  const resto = codecs.filter((c) => {
    const tipo = c.mimeType.toLowerCase();
    return tipo !== 'video/h264' && !SEM_FEC_NO_VIDEO.has(tipo);
  });
  return [...ordenarH264(h264), ...resto];
}

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
 * variantes, então não há o que preferir. E ele não é mais reescrito na
 * entrada por padrão — ver ADR 0020.
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
