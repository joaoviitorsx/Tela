/**
 * `RTCPeerConnection` falso, suficiente para exercitar negociação e topologia
 * sem browser.
 *
 * Reproduz o que importa: `signalingState` muda com set{Local,Remote}Description,
 * `negotiationneeded` dispara ao adicionar trilha, e `setParameters` guarda o
 * que foi aplicado — é por ele que os testes provam que todos os peers
 * recebem encoding IDÊNTICO (AGENTS.md R5).
 */
export class FakeSender {
  applied: RTCRtpSendParameters[] = [];
  /** Encodings antes do primeiro `setParameters`. `[]` = ainda não negociado. */
  encodingsIniciais: RTCRtpEncodingParameters[] = [{}];
  /** Decide se a chamada rejeita, olhando o que foi pedido. `null` aceita. */
  recusar: ((params: RTCRtpSendParameters) => Error | null) | null = null;
  /** `null` depois de `replaceTrack(null)` — a pausa da cascata (ADR 0031). */
  track: MediaStreamTrack | null;
  readonly trocas: Array<MediaStreamTrack | null> = [];
  constructor(track: MediaStreamTrack) {
    this.track = track;
  }

  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.track = track;
    this.trocas.push(track);
  }

  getParameters(): RTCRtpSendParameters {
    return (this.applied.at(-1) ?? {
      encodings: this.encodingsIniciais.map((e) => ({ ...e })),
    }) as RTCRtpSendParameters;
  }
  async setParameters(params: RTCRtpSendParameters): Promise<void> {
    const erro = this.recusar?.(params) ?? null;
    if (erro !== null) throw erro;
    this.applied.push(params);
  }
}

export class FakePeerConnection {
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  currentConfig: RTCConfiguration;
  restartCount = 0;

  readonly senders: FakeSender[] = [];
  readonly candidatesAdded: RTCIceCandidateInit[] = [];
  readonly transceivers: {
    sender: FakeSender;
    setCodecPreferences?: unknown;
    extensoes: { uri: string; direction: string }[];
    getHeaderExtensionsToNegotiate: () => { uri: string; direction: string }[];
    setHeaderExtensionsToNegotiate: (e: { uri: string; direction: string }[]) => void;
  }[] = [];
  /** O que `getReceivers()` devolve; o teste de captura preenche. */
  receivers: unknown[] = [];
  /** Linhas de `getStats()`. */
  statsLinhas: Record<string, unknown>[] = [];

  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  /** Faz `setLocalDescription` lançar, para exercitar falha de negociação. */
  failLocalDescription = false;

  constructor(readonly config: RTCConfiguration) { this.currentConfig = config; }

  getConfiguration(): RTCConfiguration { return this.currentConfig; }
  setConfiguration(config: RTCConfiguration): void { this.currentConfig = config; }
  restartIce(): void {
    this.restartCount += 1;
    queueMicrotask(() => this.onnegotiationneeded?.());
  }

  addTrack(track: MediaStreamTrack): FakeSender {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    const t = {
      sender,
      extensoes: [
        { uri: 'urn:ietf:params:rtp-hdrext:toffset', direction: 'sendrecv' },
        { uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time', direction: 'stopped' },
      ],
      getHeaderExtensionsToNegotiate: () => t.extensoes.map((e) => ({ ...e })),
      setHeaderExtensionsToNegotiate: (e: { uri: string; direction: string }[]) => {
        t.extensoes = e;
      },
    };
    this.transceivers.push(t);
    queueMicrotask(() => this.onnegotiationneeded?.());
    return sender;
  }

  getSenders(): FakeSender[] {
    return this.senders;
  }
  getReceivers(): unknown[] {
    return this.receivers;
  }
  getTransceivers(): { sender: FakeSender }[] {
    return this.transceivers;
  }

  /** SDP que `createAnswer` devolve; o teste troca para ter Opus de verdade. */
  answerSdp = 'v=0 answer';

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.failLocalDescription) throw new Error('InvalidStateError');
    return { type: 'answer', sdp: this.answerSdp };
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    if (this.failLocalDescription) throw new Error('InvalidStateError');
    const type = this.remoteDescription?.type === 'offer' ? 'answer' : 'offer';
    this.localDescription = description ?? { type, sdp: `v=0 ${type}` };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.remoteDescription === null) throw new Error('sem remoteDescription');
    this.candidatesAdded.push(candidate);
  }

  async getStats(): Promise<RTCStatsReport> {
    return statsReport(this.statsLinhas);
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }

  /* ─── só no fake ─── */
  emitState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  emitCandidate(candidate: string): void {
    this.onicecandidate?.({
      candidate: { candidate, toJSON: () => ({ candidate }) } as unknown as RTCIceCandidate,
    });
  }
}

export function fakeConnectionFactory(): {
  create: (config: RTCConfiguration) => RTCPeerConnection;
  created: FakePeerConnection[];
} {
  const created: FakePeerConnection[] = [];
  return {
    created,
    create: (config) => {
      const pc = new FakePeerConnection(config);
      created.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
  };
}

export function statsReport(entries: Record<string, unknown>[]): RTCStatsReport {
  return {
    forEach(callback: (value: unknown, key: string) => void) {
      entries.forEach((entry, index) => callback(entry, String(entry['id'] ?? index)));
    },
  } as unknown as RTCStatsReport;
}
