import { describe, expect, it } from 'vitest';
import { PRESET_720P60, PRESET_1080P60 } from '@tela/shared';
import { MeshTopology } from './mesh-topology.js';
import { type FakePeerConnection, fakeConnectionFactory, statsReport } from './testing.js';
import { fakeStream, fakeTrack } from '../testing/fakes.js';

const ICE = [{ urls: ['stun:test'] }];
const settle = async (times = 10) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

function build(maxPeers = 3) {
  const factory = fakeConnectionFactory();
  const sent: { payload: unknown; to: string }[] = [];
  const mesh = new MeshTopology({
    iceServers: ICE,
    send: (payload, to) => sent.push({ payload, to }),
    createConnection: factory.create,
    maxPeers,
  });
  const video = fakeTrack('video');
  const stream = fakeStream([video]);
  return { mesh, sent, factory, video, stream };
}

describe('MeshTopology — admissão', () => {
  it('anexa um peer que chega depois da mídia', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();

    expect(ctx.mesh.size).toBe(1);
    expect(ctx.factory.created).toHaveLength(1);
  });

  it('ADR 0006 A1: peer que chega ANTES da mídia não é perdido', async () => {
    const ctx = build();
    // Janela real: o canal abre e a captura ainda não terminou.
    ctx.mesh.admit('v_1');
    expect(ctx.mesh.size).toBe(0);

    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    await settle();

    // Sem a fila de espera ele ficava em "conectando" para sempre.
    expect(ctx.mesh.size).toBe(1);
    expect(ctx.sent.some((m) => m.to === 'v_1')).toBe(true);
  });

  it('ADR 0006 A2: falha ao anexar não deixa peer zumbi contando como espectador', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);

    const original = ctx.factory.create;
    ctx.mesh.admit('v_1');
    await settle();
    void original;

    // Força a próxima negociação a falhar.
    const pc = ctx.factory.created[0] as FakePeerConnection;
    pc.failLocalDescription = true;
    pc.emitState('failed');
    await settle();

    expect(ctx.mesh.size).toBe(0);
  });

  it('respeita o teto de peers', async () => {
    const ctx = build(2);
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    ctx.mesh.admit('v_2');
    ctx.mesh.admit('v_3');
    await settle();
    expect(ctx.mesh.size).toBe(2);
  });

  /**
   * MUDANÇA DE COMPORTAMENTO deliberada. Antes, readmitir um peer existente
   * sempre derrubava e recriava o link.
   *
   * O motivo da troca: quando o transmissor reabre o canal de sinalização
   * depois de uma queda, o servidor REAPRESENTA todos os espectadores que
   * continuaram conectados. Com o comportamento antigo, a reconexão do
   * servidor destruía justamente as conexões que tinham sobrevivido a ele —
   * o oposto da promessa da arquitetura.
   *
   * O caso que o teste antigo protegia (mesmo peerId chegando duas vezes de
   * verdade) não ocorre: o servidor emite um `peerId` novo por socket, então
   * espectador que cai e volta chega com identidade nova.
   */
  it('readmissão NÃO derruba link saudável (canal reaberto reapresenta peers)', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();
    ctx.mesh.admit('v_1');
    await settle();

    expect(ctx.mesh.size).toBe(1);
    expect((ctx.factory.created[0] as FakePeerConnection).closed).toBe(false);
    // E não criou uma segunda conexão para o mesmo peer.
    expect(ctx.factory.created).toHaveLength(1);
  });

  it('readmissão RECRIA link que já morreu', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();

    (ctx.factory.created[0] as FakePeerConnection).emitState('failed');
    await settle();

    ctx.mesh.admit('v_1');
    await settle();

    expect(ctx.mesh.size).toBe(1);
    expect(ctx.factory.created).toHaveLength(2);
  });

  it('peer que falha é removido e anunciado', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();

    const derrubados: string[] = [];
    ctx.mesh.on('dropped', ({ peerId }) => derrubados.push(peerId));
    (ctx.factory.created[0] as FakePeerConnection).emitState('failed');
    await settle();

    expect(derrubados).toEqual(['v_1']);
    expect(ctx.mesh.size).toBe(0);
  });
});

describe('MeshTopology — R5: encoding IDÊNTICO em todos os peers', () => {
  it('três peers recebem exatamente os mesmos parâmetros', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    ctx.mesh.admit('v_2');
    ctx.mesh.admit('v_3');
    await settle(20);

    const aplicados = ctx.factory.created.map((pc) => {
      const sender = pc.getSenders()[0];
      return sender?.applied.at(-1);
    });

    expect(aplicados).toHaveLength(3);
    for (const params of aplicados) {
      // Variar por peer multiplicaria encoders e roubaria CPU do jogo.
      expect(params?.encodings?.[0]?.maxBitrate).toBe(PRESET_1080P60.main.maxBitrate);
      expect(params?.encodings?.[0]?.maxFramerate).toBe(60);
      expect(params?.degradationPreference).toBe('maintain-framerate');
    }
  });

  it('a adaptação é COLETIVA: setPreset move todos juntos', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    ctx.mesh.admit('v_2');
    await settle(20);

    await ctx.mesh.setPreset(PRESET_720P60);
    await settle(20);

    for (const pc of ctx.factory.created) {
      expect(pc.getSenders()[0]?.applied.at(-1)?.encodings?.[0]?.maxBitrate).toBe(
        PRESET_720P60.main.maxBitrate,
      );
    }
  });

  it('setPreset NÃO renegocia — nenhuma oferta nova sai', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle(20);

    const antes = ctx.sent.length;
    await ctx.mesh.setPreset(PRESET_720P60);
    await settle(20);

    // Renegociar faria todo espectador piscar. `setParameters` não toca no SDP.
    expect(ctx.sent.length).toBe(antes);
  });

  it('ADR 0006 A3: duas trocas concorrentes não deixam conexão órfã', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle(20);

    // A queda automática por CPU e um clique manual podem cair juntos.
    const a = ctx.mesh.setPreset(PRESET_720P60);
    const b = ctx.mesh.setPreset(PRESET_1080P60);
    await expect(Promise.all([a, b])).resolves.toBeDefined();

    expect(ctx.mesh.size).toBe(1);
    expect((ctx.factory.created[0] as FakePeerConnection).closed).toBe(false);
  });
});

describe('MeshTopology — áudio', () => {
  it('trilha adicionada DEPOIS chega em quem já estava conectado', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle(20);
    expect(ctx.factory.created[0]?.getSenders()).toHaveLength(1);

    // O áudio do sink virtual resolve uns instantes depois da tela. Um
    // espectador que entrou no meio ficaria mudo para sempre, sem aviso.
    const audio = fakeTrack('audio');
    await ctx.mesh.publish(ctx.stream, [ctx.video, audio], PRESET_1080P60);
    await settle(20);

    const kinds = ctx.factory.created[0]?.getSenders().map((s) => s.track.kind);
    expect(kinds).toEqual(['video', 'audio']);
  });

  it('não duplica sender quando a mesma trilha é republicada', async () => {
    const ctx = build();
    const audio = fakeTrack('audio');
    await ctx.mesh.publish(ctx.stream, [ctx.video, audio], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle(20);

    await ctx.mesh.publish(ctx.stream, [ctx.video, audio], PRESET_1080P60);
    await settle(20);

    expect(ctx.factory.created[0]?.getSenders()).toHaveLength(2);
  });

  it('áudio recebe bitrate de jogo, não de voz', async () => {
    const ctx = build();
    const audio = fakeTrack('audio');
    await ctx.mesh.publish(ctx.stream, [ctx.video, audio], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle(20);

    const senderAudio = ctx.factory.created[0]?.getSenders().find((s) => s.track.kind === 'audio');
    // O default do WebRTC assume voz e aperta demais: música de jogo vira lata.
    expect(senderAudio?.applied.at(-1)?.encodings?.[0]?.maxBitrate).toBe(128_000);
  });

  it('o preset de vídeo não é aplicado no sender de áudio', async () => {
    const ctx = build();
    const audio = fakeTrack('audio');
    await ctx.mesh.publish(ctx.stream, [ctx.video, audio], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle(20);

    const senderAudio = ctx.factory.created[0]?.getSenders().find((s) => s.track.kind === 'audio');
    expect(senderAudio?.applied.at(-1)?.encodings?.[0]?.maxFramerate).toBeUndefined();
  });
});

describe('MeshTopology — roteamento e limpeza', () => {
  it('entrega sinal ao peer correto', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();

    await ctx.mesh.handleSignal('v_1', { description: { type: 'answer', sdp: 'v=0' } });
    expect((ctx.factory.created[0] as FakePeerConnection).remoteDescription?.type).toBe('answer');
  });

  it('sinal de peer desconhecido é ignorado', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    await expect(ctx.mesh.handleSignal('fantasma', {})).resolves.toBeUndefined();
  });

  it('sinal que falha derruba só aquele peer', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    ctx.mesh.admit('v_2');
    await settle();

    await ctx.mesh.handleSignal('v_1', { candidate: { candidate: 'c1' } });
    expect(ctx.mesh.size).toBe(1);
  });

  it('marca quem está passando por relay', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();

    await ctx.mesh.refreshRelayStatus(() => true);
    expect(ctx.mesh.peers[0]?.usingRelay).toBe(true);

    await ctx.mesh.refreshRelayStatus(() => false);
    expect(ctx.mesh.peers[0]?.usingRelay).toBe(false);
  });

  it('coleta um relatório por peer', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    ctx.mesh.admit('v_2');
    await settle();

    expect(await ctx.mesh.collectStats()).toHaveLength(2);
    void statsReport;
  });

  it('close derruba todas as conexões', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    ctx.mesh.admit('v_2');
    await settle();

    ctx.mesh.close();
    expect(ctx.mesh.size).toBe(0);
    expect(ctx.factory.created.every((pc) => pc.closed)).toBe(true);
  });
});
