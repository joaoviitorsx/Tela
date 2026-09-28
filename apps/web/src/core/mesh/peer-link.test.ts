import { describe, expect, it } from 'vitest';
import { PeerLink, ordenarH264, type SignalPayload } from './peer-link.js';
import { type FakePeerConnection, fakeConnectionFactory } from './testing.js';
import { fakeStream, fakeTrack } from '../testing/fakes.js';

const ICE = [{ urls: ['stun:test'] }];

function build(polite: boolean, now: () => number = Date.now) {
  const factory = fakeConnectionFactory();
  const sent: SignalPayload[] = [];
  const issues: string[] = [];
  const fatals: string[] = [];
  const link = new PeerLink({
    peerId: 'p_1',
    polite,
    iceServers: ICE,
    send: (payload) => sent.push(payload as SignalPayload),
    createConnection: factory.create,
    onIssue: (code) => issues.push(code),
    onFatal: (code) => fatals.push(code),
    now,
  });
  return { link, sent, issues, fatals, pc: factory.created[0] as FakePeerConnection };
}

const settle = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

describe('PeerLink — perfect negotiation', () => {
  it('oferece quando a negociação é necessária', async () => {
    const ctx = build(false);
    ctx.link.addTrack(fakeTrack('video'), fakeStream());
    await settle();

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]?.description?.type).toBe('offer');
  });

  it('responde a uma oferta com uma resposta', async () => {
    const ctx = build(true);
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0' } });

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]?.description?.type).toBe('answer');
  });

  it('aceita a resposta sem responder de volta', async () => {
    const ctx = build(false);
    await ctx.link.handleSignal({ description: { type: 'answer', sdp: 'v=0' } });
    expect(ctx.sent).toHaveLength(0);
    expect(ctx.pc.remoteDescription?.type).toBe('answer');
  });

  it('o impolite IGNORA a oferta que colide com a dele', async () => {
    const ctx = build(false);
    ctx.pc.signalingState = 'have-local-offer';

    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'do outro' } });

    // Sem essa assimetria os dois lados recuam (ou nenhum) e a negociação
    // nunca converge. É o ponto inteiro do padrão.
    expect(ctx.pc.remoteDescription).toBeNull();
    expect(ctx.sent).toHaveLength(0);
  });

  it('o polite ACEITA a oferta que colide e recua', async () => {
    const ctx = build(true);
    ctx.pc.signalingState = 'have-local-offer';

    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'do outro' } });

    expect(ctx.pc.remoteDescription?.sdp).toBe('do outro');
    expect(ctx.sent[0]?.description?.type).toBe('answer');
  });

  it('encaminha candidatos ICE locais', () => {
    const ctx = build(false);
    ctx.pc.emitCandidate('candidate:1 1 udp');
    expect(ctx.sent[0]?.candidate).toEqual({ candidate: 'candidate:1 1 udp' });
  });

  it('usa a geração do SDP quando o candidato chega antes da promessa local resolver', async () => {
    const sender = build(false);
    const receiver = build(true);
    const original = sender.pc.setLocalDescription.bind(sender.pc);
    sender.pc.setLocalDescription = async (description) => {
      await original(description);
      sender.pc.localDescription = { type: 'offer', sdp: 'v=0\na=ice-ufrag:g1' };
      sender.pc.onicecandidate?.({
        candidate: {
          candidate: 'c1',
          toJSON: () => ({ candidate: 'c1', usernameFragment: 'g1' }),
        } as RTCIceCandidate,
      });
    };

    sender.link.addTrack(fakeTrack('video'), fakeStream());
    await settle();
    expect(sender.sent.map((payload) => payload.generation)).toEqual(['g1', 'g1']);
    await receiver.link.handleSignal(sender.sent[0]);
    await receiver.link.handleSignal(sender.sent[1]);
    expect(receiver.pc.candidatesAdded).toEqual([{ candidate: 'c1', usernameFragment: 'g1' }]);
  });

  it('marca candidato da próxima geração mesmo com SDP local anterior', () => {
    const ctx = build(false);
    ctx.pc.localDescription = { type: 'offer', sdp: 'v=0\na=ice-ufrag:old' };
    ctx.pc.onicecandidate?.({
      candidate: {
        candidate: 'new',
        toJSON: () => ({ candidate: 'new', usernameFragment: 'next' }),
      } as RTCIceCandidate,
    });
    expect(ctx.sent[0]?.generation).toBe('next');
  });

  it('aplica candidato remoto depois da descrição', async () => {
    const ctx = build(true);
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0' } });
    await ctx.link.handleSignal({ candidate: { candidate: 'c1' } });
    expect(ctx.pc.candidatesAdded).toEqual([{ candidate: 'c1' }]);
  });

  it('candidato de uma oferta ignorada não derruba a conexão', async () => {
    const ctx = build(false);
    ctx.pc.signalingState = 'have-local-offer';
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'do outro' } });

    // Chega candidato daquela oferta que decidimos ignorar: é lixo esperado.
    await expect(ctx.link.handleSignal({ candidate: { candidate: 'c1' } })).resolves.toBeUndefined();
  });

  it('candidato antecipado fica na fila até a descrição remota', async () => {
    const ctx = build(true);
    await ctx.link.handleSignal({ candidate: { candidate: 'c1', usernameFragment: 'g1' } });
    expect(ctx.pc.candidatesAdded).toEqual([]);
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0\na=ice-ufrag:g1' } });
    expect(ctx.pc.candidatesAdded).toEqual([{ candidate: 'c1', usernameFragment: 'g1' }]);
  });

  it('candidato de geração antiga não entra na nova negociação', async () => {
    const ctx = build(true);
    await ctx.link.handleSignal({ candidate: { candidate: 'old', usernameFragment: 'old' } });
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0\na=ice-ufrag:new' } });
    await ctx.link.handleSignal({ candidate: { candidate: 'late-old', usernameFragment: 'old' } });
    expect(ctx.pc.candidatesAdded).toEqual([]);
    expect(ctx.issues).toContain('CANDIDATE_STALE');
    await ctx.link.handleSignal({ candidate: { candidate: 'new', usernameFragment: 'new' } });
    expect(ctx.pc.candidatesAdded).toEqual([{ candidate: 'new', usernameFragment: 'new' }]);
  });

  it('preserva candidato de uma geração futura até a descrição correspondente', async () => {
    const ctx = build(true);
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0\na=ice-ufrag:g1' } });
    await ctx.link.handleSignal({ candidate: { candidate: 'future', usernameFragment: 'g2' } });
    expect(ctx.pc.candidatesAdded).toEqual([]);
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0\na=ice-ufrag:g2' } });
    expect(ctx.pc.candidatesAdded).toEqual([{ candidate: 'future', usernameFragment: 'g2' }]);
  });

  it('descarta candidato sem geração após a troca ICE ambígua', async () => {
    const ctx = build(true);
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0\na=ice-ufrag:g1' } });
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0\na=ice-ufrag:g2' } });
    await ctx.link.handleSignal({ candidate: { candidate: 'unknown' } });
    expect(ctx.pc.candidatesAdded).toEqual([]);
    expect(ctx.issues).toContain('CANDIDATE_AMBIGUOUS');
  });

  it('aceita ufrag de outra seção de mídia no SDP legado', async () => {
    const ctx = build(true);
    await ctx.link.handleSignal({
      description: { type: 'offer', sdp: 'v=0\na=ice-ufrag:video\nm=audio\na=ice-ufrag:audio' },
    });
    await ctx.link.handleSignal({ candidate: { candidate: 'audio-candidate', usernameFragment: 'audio' } });
    expect(ctx.pc.candidatesAdded).toEqual([{ candidate: 'audio-candidate', usernameFragment: 'audio' }]);
  });

  it('limita a fila de candidatos e descarta os expirados', async () => {
    let clock = 0;
    const ctx = build(true, () => clock);
    for (let i = 0; i < 65; i += 1) {
      await ctx.link.handleSignal({ candidate: { candidate: `c${i}` } });
    }
    expect(ctx.issues).toContain('CANDIDATE_QUEUE_FULL');
    clock = 15_001;
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0' } });
    expect(ctx.pc.candidatesAdded).toEqual([]);
    expect(ctx.issues).toContain('CANDIDATE_EXPIRED');
  });

  it('fim de candidatos é sinalizado e aplicado como tal', async () => {
    const sender = build(false);
    const receiver = build(true);
    sender.pc.onicecandidate?.({ candidate: null });
    const end = sender.sent[0];
    expect(end?.candidate).toEqual({ candidate: '' });
    await receiver.link.handleSignal({ description: { type: 'offer', sdp: 'v=0' }, generation: end?.generation });
    await receiver.link.handleSignal(end);
    expect(receiver.pc.candidatesAdded).toEqual([{ candidate: '' }]);
  });

  it('candidato rejeitado é classificado sem abortar o peer', async () => {
    const ctx = build(true);
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0' } });
    ctx.pc.addIceCandidate = async () => { throw new Error('sdpMid inválido'); };
    await expect(ctx.link.handleSignal({ candidate: { candidate: 'bad' } })).resolves.toBeUndefined();
    expect(ctx.issues).toContain('CANDIDATE_REJECTED');
    expect(ctx.fatals).toEqual([]);
  });

  it('ofertas simultâneas convergem com o lado polite recuando', async () => {
    const polite = build(true);
    const impolite = build(false);
    polite.link.addTrack(fakeTrack('video'), fakeStream());
    impolite.link.addTrack(fakeTrack('video'), fakeStream());
    await settle(12);
    const offerPolite = polite.sent.find((item) => item.description?.type === 'offer');
    const offerImpolite = impolite.sent.find((item) => item.description?.type === 'offer');
    expect(offerPolite).toBeDefined();
    expect(offerImpolite).toBeDefined();
    await Promise.all([
      polite.link.handleSignal(offerImpolite),
      impolite.link.handleSignal(offerPolite),
    ]);
    const answer = polite.sent.find((item) => item.description?.type === 'answer');
    expect(answer).toBeDefined();
    await impolite.link.handleSignal(answer);
    expect(polite.pc.signalingState).toBe('stable');
    expect(impolite.pc.signalingState).toBe('stable');
    expect(impolite.pc.remoteDescription?.type).toBe('answer');
    expect(polite.fatals).toEqual([]);
    expect(impolite.fatals).toEqual([]);
  });

  it('serializa descrições concorrentes por peer', async () => {
    const ctx = build(true);
    const original = ctx.pc.setRemoteDescription.bind(ctx.pc);
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ctx.pc.setRemoteDescription = async (description) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (description.sdp === 'first') await gate;
      await original(description);
      active -= 1;
    };
    const first = ctx.link.handleSignal({ description: { type: 'offer', sdp: 'first' } });
    const second = ctx.link.handleSignal({ description: { type: 'offer', sdp: 'second' } });
    await settle();
    expect(active).toBe(1);
    release?.();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    expect(ctx.sent.filter((item) => item.description?.type === 'answer')).toHaveLength(2);
  });

  it('limita operações pendentes e classifica o excesso', async () => {
    const ctx = build(true);
    const original = ctx.pc.setRemoteDescription.bind(ctx.pc);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ctx.pc.setRemoteDescription = async (description) => { await gate; await original(description); };
    const first = ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0' } });
    await settle();
    const pending = Array.from({ length: 63 }, (_, index) =>
      ctx.link.handleSignal({ candidate: { candidate: `c${index}` } }));
    await expect(ctx.link.handleSignal({ description: { type: 'offer', sdp: 'overflow' } }))
      .rejects.toMatchObject({ code: 'NEGOTIATION_QUEUE_FULL' });
    release?.();
    await Promise.all([first, ...pending]);
  });

  it('fechamento concorrente não envia resposta nem aplica candidato', async () => {
    const ctx = build(true);
    const original = ctx.pc.setRemoteDescription.bind(ctx.pc);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ctx.pc.setRemoteDescription = async (description) => { await gate; await original(description); };
    const negotiation = ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0' } });
    await settle();
    const candidate = ctx.link.handleSignal({ candidate: { candidate: 'late' } });
    ctx.link.close();
    release?.();
    await Promise.all([negotiation, candidate]);
    expect(ctx.sent).toEqual([]);
    expect(ctx.pc.candidatesAdded).toEqual([]);
  });

  it('falha local avisa o dono do link, sem rejeição solta', async () => {
    const ctx = build(false);
    ctx.pc.failLocalDescription = true;
    ctx.link.addTrack(fakeTrack('video'), fakeStream());
    await settle(15);
    expect(ctx.fatals).toContain('LOCAL_DESCRIPTION_FAILED');
  });

  it('negotiationneeded durante oferta pendente volta a ofertar após a resposta', async () => {
    const ctx = build(false);
    ctx.link.addTrack(fakeTrack('video'), fakeStream());
    await settle(12);
    expect(ctx.pc.signalingState).toBe('have-local-offer');
    ctx.pc.onnegotiationneeded?.();
    await ctx.link.handleSignal({ description: { type: 'answer', sdp: 'v=0' } });
    await settle(12);
    expect(ctx.sent.filter((item) => item.description?.type === 'offer')).toHaveLength(2);
  });

  it('payload vazio ou lixo não quebra', async () => {
    const ctx = build(true);
    await expect(ctx.link.handleSignal(null)).resolves.toBeUndefined();
    await expect(ctx.link.handleSignal({})).resolves.toBeUndefined();
  });

  it('close solta os handlers e fecha a conexão', () => {
    const ctx = build(false);
    ctx.link.close();
    expect(ctx.pc.closed).toBe(true);
    expect(ctx.pc.onnegotiationneeded).toBeNull();
    expect(ctx.pc.ontrack).toBeNull();
  });

  it('não envia nada depois de fechado', async () => {
    const ctx = build(true);
    ctx.link.close();
    await ctx.link.handleSignal({ description: { type: 'offer', sdp: 'v=0' } });
    expect(ctx.sent).toHaveLength(0);
  });
});

/**
 * A ordem que `setCodecPreferences` recebe é a ordem que vale, e a versão
 * anterior filtrava só por `mimeType` — herdando a do navegador, que põe
 * Constrained Baseline primeiro. Baseline não tem CABAC nem transformada 8×8:
 * são 10 a 15% de bitrate a mais pela MESMA imagem, e num orçamento de 3 Mbps
 * por espectador 15% é um degrau inteiro da escada.
 */
describe('ordenarH264', () => {
  const c = (fmtp: string): RTCRtpCodec => ({ mimeType: 'video/H264', clockRate: 90_000, sdpFmtpLine: fmtp });

  const BASELINE_M1 = c('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f');
  const BASELINE_M0 = c('level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f');
  const MAIN_M1 = c('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f');
  const HIGH_M1 = c('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f');

  it('põe High profile na frente de Main e de Baseline', () => {
    const ordem = ordenarH264([BASELINE_M1, MAIN_M1, HIGH_M1]);
    expect(ordem.map((x: RTCRtpCodec) => x.sdpFmtpLine)).toEqual([
      HIGH_M1.sdpFmtpLine,
      MAIN_M1.sdpFmtpLine,
      BASELINE_M1.sdpFmtpLine,
    ]);
  });

  it('packetization-mode=1 vence QUALQUER perfil em modo 0', () => {
    // O modo 0 aceita um NAL por pacote e proíbe fragmentação: em 1080p obriga
    // o encoder a picotar o quadro, com mais overhead e pior compressão.
    const ordem = ordenarH264([BASELINE_M0, BASELINE_M1]);
    expect(ordem[0]?.sdpFmtpLine).toContain('packetization-mode=1');
  });

  it('modo tem precedência sobre perfil', () => {
    const HIGH_M0 = c('level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f');
    expect(ordenarH264([HIGH_M0, BASELINE_M1])[0]?.sdpFmtpLine).toBe(BASELINE_M1.sdpFmtpLine);
  });

  it('não descarta nada nem quebra sem fmtp', () => {
    const sem = { mimeType: 'video/H264', clockRate: 90_000 };
    const ordem = ordenarH264([sem, HIGH_M1, BASELINE_M1]);
    expect(ordem).toHaveLength(3);
    expect(ordem[0]?.sdpFmtpLine).toBe(HIGH_M1.sdpFmtpLine);
  });
});
