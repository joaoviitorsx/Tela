import { describe, expect, it } from 'vitest';
import { PeerLink, ordenarH264, type SignalPayload } from './peer-link.js';
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

  it('candidato inválido NÃO sobe como erro — subir matava a conexão', async () => {
    const ctx = build(true);
    /*
      MUDANÇA DE COMPORTAMENTO deliberada. Este teste codificava que candidato
      sem descrição remota rejeita. A regra era "candidato de oferta ignorada é
      lixo esperado; qualquer outra falha é real e deve subir".

      Só que "subir" não é um log: a topologia faz `catch { drop(from) }` e o
      espectador emite `closed: NEGOTIATION_FAILED`. Um candidato que o Chrome
      recusa parsear, um `sdpMid` de seção que o `max-bundle` derrubou, ou um
      candidato fora de ordem derrubavam a sessão inteira daquele espectador.

      A assimetria de custo decide: perder um candidato degrada o ICE — há
      outros, e o par vencedor raramente é o primeiro.
    */
    await expect(
      ctx.link.handleSignal({ candidate: { candidate: 'c1' } }),
    ).resolves.toBeUndefined();
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
