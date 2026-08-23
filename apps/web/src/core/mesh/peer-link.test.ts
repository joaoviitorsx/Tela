import { describe, expect, it } from 'vitest';
import { PeerLink, type SignalPayload } from './peer-link.js';
import { type FakePeerConnection, fakeConnectionFactory } from './testing.js';
import { fakeStream, fakeTrack } from '../testing/fakes.js';

const ICE = [{ urls: ['stun:test'] }];

function build(polite: boolean) {
  const factory = fakeConnectionFactory();
  const sent: SignalPayload[] = [];
  const link = new PeerLink({
    peerId: 'p_1',
    polite,
    iceServers: ICE,
    send: (payload) => sent.push(payload as SignalPayload),
    createConnection: factory.create,
  });
  return { link, sent, pc: factory.created[0] as FakePeerConnection };
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

  it('candidato inválido fora de colisão sobe como erro', async () => {
    const ctx = build(true);
    await expect(ctx.link.handleSignal({ candidate: { candidate: 'c1' } })).rejects.toThrow();
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
