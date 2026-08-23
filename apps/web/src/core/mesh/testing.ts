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
  constructor(readonly track: MediaStreamTrack) {}

  getParameters(): RTCRtpSendParameters {
    return (this.applied.at(-1) ?? { encodings: [{}] }) as RTCRtpSendParameters;
  }
  async setParameters(params: RTCRtpSendParameters): Promise<void> {
    this.applied.push(params);
  }
}

export class FakePeerConnection {
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;

  readonly senders: FakeSender[] = [];
  readonly candidatesAdded: RTCIceCandidateInit[] = [];
  readonly transceivers: { sender: FakeSender; setCodecPreferences?: unknown }[] = [];

  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  /** Faz `setLocalDescription` lançar, para exercitar falha de negociação. */
  failLocalDescription = false;

  constructor(readonly config: RTCConfiguration) {}

  addTrack(track: MediaStreamTrack): FakeSender {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    this.transceivers.push({ sender });
    queueMicrotask(() => this.onnegotiationneeded?.());
    return sender;
  }

  getSenders(): FakeSender[] {
    return this.senders;
  }
  getReceivers(): unknown[] {
    return [];
  }
  getTransceivers(): { sender: FakeSender }[] {
    return this.transceivers;
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
    return statsReport([]);
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
