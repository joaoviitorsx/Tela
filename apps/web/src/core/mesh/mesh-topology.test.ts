import { describe, expect, it } from 'vitest';
import { BPP_PISO, BPP_TETO, tetoDeBitrate, PRESET_480P60, PRESET_720P60, PRESET_1080P60 } from '@tela/shared';
import { MeshTopology } from './mesh-topology.js';
import { type FakePeerConnection, fakeConnectionFactory, statsReport } from './testing.js';
import { fakeStream, fakeTrack } from '../testing/fakes.js';

const ICE = [{ urls: ['stun:test'] }];
const settle = async (times = 10) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

function build(maxPeers = 3, onPeerStateChange?: (peerId: string, state: RTCPeerConnectionState) => void) {
  const factory = fakeConnectionFactory();
  const sent: { payload: unknown; to: string }[] = [];
  const mesh = new MeshTopology({
    iceServers: ICE,
    send: (payload, to) => sent.push({ payload, to }),
    createConnection: factory.create,
    maxPeers,
    ...(onPeerStateChange === undefined ? {} : { onPeerStateChange }),
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

  it('reapresentação da mesma tentativa preserva a PC; nova tentativa reconstrói uma só vaga', async () => {
    const ctx = build(1);
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1', 'attempt-1');
    await settle();
    const first = ctx.factory.created[0] as FakePeerConnection;
    ctx.mesh.admit('v_1', 'attempt-1');
    expect(ctx.factory.created).toHaveLength(1);
    ctx.mesh.admit('v_1', 'attempt-2');
    await settle();
    expect(first.closed).toBe(true);
    expect(ctx.factory.created).toHaveLength(2);
    expect(ctx.mesh.size).toBe(1);
  });

  it('renova as configurações de todas as PCs abertas sem interromper a mídia', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    ctx.mesh.admit('v_2');
    await settle();
    ctx.mesh.setIceServers([{ urls: 'turn:relay.test', username: 'renewed', credential: 'secret' }]);
    expect(ctx.factory.created.map((pc) => pc.currentConfig.iceServers?.[0]?.username))
      .toEqual(['renewed', 'renewed']);
    expect(ctx.factory.created.map((pc) => pc.restartCount)).toEqual([0, 0]);
    expect(ctx.mesh.size).toBe(2);
  });

  it('reapresentação no signaling não antecipa reconstrução de um peer em recuperação', async () => {
    const ctx = build(1, () => undefined);
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1', 'attempt-1');
    await settle();
    (ctx.factory.created[0] as FakePeerConnection).emitState('failed');
    ctx.mesh.admit('v_1', 'attempt-1');
    expect(ctx.factory.created).toHaveLength(1);
    expect(ctx.mesh.size).toBe(1);
  });

  it('falha de setConfiguration adia a reconstrução até a recuperação ser necessária', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();
    const old = ctx.factory.created[0] as FakePeerConnection;
    old.setConfiguration = () => { throw new Error('InvalidModificationError'); };
    ctx.mesh.setIceServers([{ urls: 'turn:relay.test', username: 'new', credential: 'secret' }]);
    expect(old.closed).toBe(false);
    expect(ctx.mesh.restart('v_1')).toBe(false);
    ctx.mesh.rebuild('v_1');
    expect(old.closed).toBe(true);
    expect(ctx.factory.created[1]?.config.iceServers?.[0]?.username).toBe('new');
  });

  it('falha na oferta local remove só o peer afetado', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_ruim');
    const failed = ctx.factory.created[0] as FakePeerConnection;
    failed.failLocalDescription = true;
    ctx.mesh.admit('v_bom');
    await settle(25);
    expect(failed.closed).toBe(true);
    expect(ctx.mesh.peers.map((peer) => peer.id)).toEqual(['v_bom']);
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
      /*
        O número mudou (ADR 0018) e o invariante não: antes da primeira
        medição o teto passou a ser o ÚTIL — 0,20 bpp — e não o nominal do
        preset. Teto não empurra: o alocador entrega ao encoder
        `min(BWE, maxBitrate)`, então limitar em 12 Mbps só cegava o
        estimador, que o libwebrtc tampa em `1,5 × acked`.

        O que a R5 exige continua exigido, e é o `for` em volta deste
        `expect`: TODOS os peers com o MESMO valor.
      */
      expect(params?.encodings?.[0]?.maxBitrate).toBe(Math.round(tetoDeBitrate(1920, 1080, 60)));
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

    // Sem medição o teto é o útil do degrau NOVO (0,20 bpp em 1280×720@60).
    // O que a R5 exige é o `for`: todos com o MESMO valor, sempre.
    for (const pc of ctx.factory.created) {
      expect(pc.getSenders()[0]?.applied.at(-1)?.encodings?.[0]?.maxBitrate).toBe(
        Math.round(tetoDeBitrate(1280, 720, 60)),
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

  it('candidato ruim NÃO derruba o peer — só degrada o ICE', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    ctx.mesh.admit('v_2');
    await settle();

    // Antes isto derrubava `v_1`. Perder um candidato tem outros; derrubar o
    // peer termina a sessão daquele espectador.
    await ctx.mesh.handleSignal('v_1', { candidate: { candidate: 'c1' } });
    expect(ctx.mesh.size).toBe(2);
  });

  it('marca quem está passando por relay', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();

    // O status de relay saiu de `refreshRelayStatus` — que fazia uma SEGUNDA
    // coleta de `getStats()` por peer, por segundo — e passou a sair do mesmo
    // relatório que `collectStats` já colhia.
    await ctx.mesh.collectStats(() => true);
    expect(ctx.mesh.peers[0]?.usingRelay).toBe(true);

    await ctx.mesh.collectStats(() => false);
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

  it('rodízio (B2): até 5 peers lê todos; com 20 lê menos e reentrega a leitura retida', async () => {
    const pequena = build(5);
    await pequena.mesh.publish(pequena.stream, [pequena.video], PRESET_1080P60);
    for (let i = 0; i < 5; i += 1) pequena.mesh.admit(`v_${i}`);
    await settle();
    const lidos = (ctx: ReturnType<typeof build>) => {
      let n = 0;
      for (const pc of ctx.factory.created) {
        const original = pc.getStats.bind(pc);
        pc.getStats = async () => {
          n += 1;
          return original();
        };
      }
      return () => n;
    };
    const contaPequena = lidos(pequena);
    const r1 = await pequena.mesh.collectStats();
    expect(contaPequena()).toBe(5);
    expect(r1.every((r) => r.fresco === true)).toBe(true);

    const grande = build(20);
    await grande.mesh.publish(grande.stream, [grande.video], PRESET_1080P60);
    for (let i = 0; i < 20; i += 1) grande.mesh.admit(`v_${i}`);
    await settle(30);
    // Relatório de caminho assentado, para o aquecimento passar.
    for (const pc of grande.factory.created) {
      pc.getStats = async () =>
        statsReport([
          { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'none', bytesSent: 1, timestamp: 1 },
          { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 50_000_000 },
        ]);
    }
    const contaGrande = lidos(grande);
    for (let t = 0; t < 12; t += 1) await grande.mesh.collectStats(); // aquecimento
    const antes = contaGrande();
    const tiques = 12;
    let frescos = 0;
    let retidos = 0;
    for (let t = 0; t < tiques; t += 1) {
      const reports = await grande.mesh.collectStats();
      expect(reports).toHaveLength(20); // os retidos voltam: o consumidor vê a sala inteira
      frescos += reports.filter((r) => r.fresco === true).length;
      retidos += reports.filter((r) => r.fresco === false).length;
    }
    expect(retidos).toBeGreaterThan(0);
    expect(contaGrande() - antes).toBe(frescos);
    expect(frescos / tiques).toBeLessThan(10); // 20 → ≈ ⌈20/4⌉ + piores
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

/**
 * O defeito da ADR 0015, visto de dentro do transporte.
 *
 * O teto de upload sempre foi aplicado como `maxBitrate`, e `maxBitrate`
 * sozinho não tira um pixel do encoder. Estes testes fixam as duas metades do
 * conserto: os bits acompanham o teto, e os PIXELS acompanham o degrau que a
 * sessão manda — de forma que os bits por pixel nunca desabam.
 */
describe('MeshTopology — bits por pixel honestos (ADR 0015 e 0017)', () => {
  const encodingDe = (pc: FakePeerConnection) =>
    pc.senders[0]?.applied.at(-1)?.encodings?.[0];

  it('o ORÇAMENTO manda, mesmo acima do nominal do degrau', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_480P60);
    ctx.mesh.admit('v_1');
    await settle();

    // O link paga 3 Mbps; o nominal do 480p60 é 2,5. Aplicar `min` jogaria
    // fora 500 kbps que o link comprovadamente entrega — e num quadro de
    // 854×480 esses 500 kbps são 0,10 → 0,12 bit por pixel.
    await ctx.mesh.setOrcamento(3_000_000);
    await settle();

    expect(encodingDe(ctx.factory.created[0]!)?.maxBitrate).toBe(3_000_000);
  });

  it('o orçamento NÃO passa do útil: acima de 0,20 bpp o bit não vira imagem', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_480P60);
    ctx.mesh.admit('v_1');
    await settle();

    await ctx.mesh.setOrcamento(90_000_000);
    await settle();

    const aplicado = encodingDe(ctx.factory.created[0]!)?.maxBitrate ?? 0;
    const { width, height } = PRESET_480P60;
    expect(aplicado).toBeLessThanOrEqual(tetoDeBitrate(width, height, 60));
  });

  it('bppAtual nunca cai abaixo do piso enquanto o degrau acompanhar o orçamento', async () => {
    const ctx = build();
    // É o pareamento que a sessão passou a garantir: orçamento de 3 Mbps
    // chega junto com o degrau de 480p60, não com o de 1080p60.
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_480P60);
    await ctx.mesh.setOrcamento(3_000_000);

    expect(ctx.mesh.bppAtual()).toBeGreaterThanOrEqual(BPP_PISO);
  });

  it('o pareamento ERRADO é o que produzia a imagem borrada', () => {
    // Documenta a aritmética do defeito, sem reintroduzi-lo: 1920×1080@60 com
    // 3 Mbps são 0,024 bpp, um quarto do piso. Nenhum encoder salva isso.
    const { width, height } = PRESET_1080P60;
    expect(3_000_000 / (width * height * 60)).toBeLessThan(BPP_PISO / 3);
  });

  it('nitidez corta o framerate para 30 — é o que paga a resolução maior', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_720P60);
    ctx.mesh.admit('v_1');
    await settle();

    await ctx.mesh.setPrioridade('nitidez');
    await settle();

    const encoding = encodingDe(ctx.factory.created[0]!);
    expect(encoding?.maxFramerate).toBe(30);
    // E o `degradationPreference` acompanha, como já acompanhava.
    expect(ctx.factory.created[0]!.senders[0]?.applied.at(-1)?.degradationPreference).toBe(
      'maintain-resolution',
    );
  });

  it('fluidez mantém os 60fps do preset', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_720P60);
    ctx.mesh.admit('v_1');
    await settle();

    await ctx.mesh.setPrioridade('nitidez');
    await ctx.mesh.setPrioridade('fluidez');
    await settle();

    expect(encodingDe(ctx.factory.created[0]!)?.maxFramerate).toBe(60);
  });
});

/**
 * O defeito da ADR 0017: o caminho que gasta a banda medida existia e estava
 * trancado atrás da ESCASSEZ. Quem tinha link sobrando nunca chegava nele.
 */
describe('MeshTopology — banda de sobra vira imagem (ADR 0017)', () => {
  const encodingDe = (pc: FakePeerConnection) =>
    pc.senders[0]?.applied.at(-1)?.encodings?.[0];

  it('orçamento fartíssimo leva o bitrate ao teto ÚTIL, não ao nominal', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();

    // 800 Mbps de subida com dois espectadores: 300 Mbps por espectador.
    await ctx.mesh.setOrcamento(300_000_000);
    await settle();

    const aplicado = encodingDe(ctx.factory.created[0]!)?.maxBitrate ?? 0;
    // Antes: 12 Mbps, o nominal — 0,096 bpp, o piso onde a imagem só não
    // quebra. Agora: 0,20 bpp, que em 1080p60 são 24,9 Mbps.
    // 0,13 bpp em 1080p60 são 16,2 Mbps contra os 12 do nominal.
    expect(aplicado).toBeGreaterThan(PRESET_1080P60.main.maxBitrate * 1.3);
    expect(ctx.mesh.bppAtual()).toBeCloseTo(BPP_TETO, 2);
  });

  it('sem medição, o TETO é o útil — teto não empurra, só limita', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();

    /*
      MUDANÇA DE CONTRATO (ADR 0018). Antes devolvia o nominal do preset,
      "o palpite calibrado". Parecia prudente e era o contrário: o
      `AimdRateControl` tampa a estimativa em `1,5 × acked`, e `acked` não
      passa do nosso teto — então 12 Mbps de teto inicial limitavam a primeira
      leitura a 18 Mbps e o orçamento a 13,5, num link de 800 Mbps.

      Teto não empurra: o alocador entrega `min(BWE, maxBitrate)` ao encoder.
      Quem empurra é o bitrate INICIAL, e esse continua conservador.
    */
    expect(encodingDe(ctx.factory.created[0]!)?.maxBitrate).toBe(Math.round(tetoDeBitrate(1920, 1080, 60)));
    expect(ctx.mesh.bitrateInicial()).toBe(PRESET_1080P60.main.maxBitrate);
  });

  it('NUNCA fura o orçamento, nem em nitidez', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_720P60);
    ctx.mesh.admit('v_1');
    await settle();

    /*
      O bug: `max(nominal, orçamento)`. Em nitidez o degrau escolhido roda a
      30fps e pode ter nominal de até o DOBRO do que o link paga — 3 Mbps de
      orçamento viravam 5,5 Mbps de demanda. O governador produzindo o
      afogamento que ele existe para impedir.
    */
    await ctx.mesh.setPrioridade('nitidez');
    await ctx.mesh.setOrcamento(3_000_000);
    await settle();

    const aplicado = encodingDe(ctx.factory.created[0]!)?.maxBitrate ?? 0;
    expect(aplicado).toBeLessThanOrEqual(3_000_000);
  });
});

describe('MeshTopology — a escala tira PIXEL de verdade', () => {
  const encodingDe = (pc: FakePeerConnection) =>
    pc.senders[0]?.applied.at(-1)?.encodings?.[0];

  it('descer de degrau reduz a resolução, não só o bitrate', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();

    // Captura em 1920: no topo da escada não há o que encolher.
    expect(encodingDe(ctx.factory.created[0]!)?.scaleResolutionDownBy).toBe(1);

    await ctx.mesh.setPreset(PRESET_480P60);
    await settle();

    /*
      2,25 e não 2,248: a escala passou a ser o MAIOR dos dois fatores
      (1920/854 = 2,2482 e 1080/480 = 2,25). Olhar só a largura custava até
      11% de bits por pixel numa captura 16:10 — 1920×1200 devolvia escala 1
      contra um alvo de 1920×1080, e o encoder recebia 11% mais pixel do que
      o orçamento pagou.
    */
    const escala = encodingDe(ctx.factory.created[0]!)?.scaleResolutionDownBy ?? 0;
    expect(escala).toBeCloseTo(1080 / PRESET_480P60.height, 3);
  });

  it('escala medida cedo demais é corrigida no relógio das estatísticas', async () => {
    const ctx = build();
    /*
      `getSettings().width` pode ser 0 numa trilha recém-criada, e `escalaPara`
      devolve 1 por segurança. Um `1` errado manda 1920×1080 com o bitrate de
      um degrau menor — a definição de quadriculado.

      O agravante: nada corrigia. `applyPreset` só roda de novo em troca de
      preset, orçamento, prioridade ou trilha, e um sender que ACEITOU os
      parâmetros errados não entra na fila de pendentes.
    */
    ctx.video.settings = { width: 0, height: 0 } as MediaTrackSettings;
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_480P60);
    ctx.mesh.admit('v_1');
    await settle();
    expect(encodingDe(ctx.factory.created[0]!)?.scaleResolutionDownBy).toBe(1);

    // A captura engatou e passou a reportar a resolução real.
    ctx.video.settings = { width: 1920, height: 1080 } as MediaTrackSettings;
    await ctx.mesh.collectStats();
    await settle();

    const escala = encodingDe(ctx.factory.created[0]!)?.scaleResolutionDownBy ?? 0;
    expect(escala).toBeCloseTo(1080 / PRESET_480P60.height, 3);
  });

  it('a escala olha as DUAS dimensões — 16:10 não escapa', async () => {
    const ctx = build();
    // Notebook 1920×1200. Pela largura, `1920 <= 1920` daria escala 1 e o
    // encoder receberia 11% mais pixel do que o orçamento pagou.
    ctx.video.settings = { width: 1920, height: 1200 } as MediaTrackSettings;
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle();

    const escala = encodingDe(ctx.factory.created[0]!)?.scaleResolutionDownBy ?? 0;
    expect(escala).toBeCloseTo(1200 / 1080, 3);
  });

  it('escala estável não reconfigura o encoder a cada segundo', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_480P60);
    ctx.mesh.admit('v_1');
    await settle();

    const antes = ctx.factory.created[0]!.senders[0]!.applied.length;
    for (let i = 0; i < 10; i += 1) await ctx.mesh.collectStats();
    await settle();

    expect(ctx.factory.created[0]!.senders[0]!.applied.length).toBe(antes);
  });
});

describe('MeshTopology — parâmetros de áudio verificáveis (TELA-008)', () => {
  const erro = (name: string) => Object.assign(new Error('x'), { name });

  async function comAudio(peers: string[]) {
    const ctx = build(5);
    const audio = fakeTrack('audio');
    await ctx.mesh.publish(ctx.stream, [ctx.video, audio], PRESET_1080P60);
    const senders = peers.map((id) => {
      ctx.mesh.admit(id);
      const pc = ctx.factory.created.at(-1) as FakePeerConnection;
      return pc.getSenders().find((s) => s.track.kind === 'audio')!;
    });
    return { ctx, senders };
  }
  const amostra = async (ctx: ReturnType<typeof build>) => {
    await ctx.mesh.collectStats();
    await settle(20);
  };

  it('sender sem encoding negociado: não fabrica [{}], espera e aplica quando negocia', async () => {
    const { ctx, senders } = await comAudio(['v_1']);
    const sender = senders[0]!;
    sender.encodingsIniciais = [];
    await settle(20);

    expect(sender.applied).toHaveLength(0);
    expect(ctx.mesh.resumoConfigAudio()).toMatchObject({ aguardando: 1, aplicados: 0 });

    sender.encodingsIniciais = [{ active: true }];
    await amostra(ctx);

    expect(sender.applied.at(-1)?.encodings).toHaveLength(1);
    expect(sender.applied.at(-1)?.encodings?.[0]).toMatchObject({ maxBitrate: 128_000, active: true });
    expect(ctx.mesh.resumoConfigAudio()).toMatchObject({ aplicados: 1, aguardando: 0, maxBitrate: 128_000 });
  });

  it('esperar a negociação não gasta as tentativas de falha', async () => {
    const { ctx, senders } = await comAudio(['v_1']);
    const sender = senders[0]!;
    sender.encodingsIniciais = [];
    await settle(20);
    for (let i = 0; i < 10; i += 1) await amostra(ctx);
    expect(ctx.mesh.resumoConfigAudio()?.aguardando).toBe(1);

    sender.encodingsIniciais = [{}];
    await amostra(ctx);
    expect(ctx.mesh.resumoConfigAudio()?.aplicados).toBe(1);
  });

  it('recusa da prioridade opcional não impede o bitrate essencial', async () => {
    const { ctx, senders } = await comAudio(['v_1']);
    senders[0]!.recusar = (p) =>
      p.encodings?.[0]?.networkPriority !== undefined ? erro('OperationError') : null;
    await settle(20);

    const aplicado = senders[0]!.applied.at(-1)?.encodings?.[0];
    expect(aplicado?.maxBitrate).toBe(128_000);
    expect(aplicado?.networkPriority).toBeUndefined();
    expect(ctx.mesh.resumoConfigAudio()).toMatchObject({
      aplicados: 1, comPrioridade: 0, ultimoErro: 'OperationError',
    });
  });

  it('recusa persistente: tentativas limitadas, erro registrado, e os outros peers seguem', async () => {
    const { ctx, senders } = await comAudio(['v_1', 'v_2']);
    senders[0]!.recusar = () => erro('InvalidModificationError');
    await settle(20);
    for (let i = 0; i < 6; i += 1) await amostra(ctx);

    expect(senders[1]!.applied.at(-1)?.encodings?.[0]?.maxBitrate).toBe(128_000);
    const resumo = ctx.mesh.resumoConfigAudio();
    expect(resumo).toMatchObject({
      senders: 2, aplicados: 1, desistiu: 1, ultimoErro: 'InvalidModificationError',
    });
    // Só um sender aceitou: o teto afirmado é o dele, e o `desistiu` diz o resto.
    expect(resumo?.maxBitrate).toBe(128_000);
  });

  it('não afirma teto quando nada foi aplicado', async () => {
    const { ctx, senders } = await comAudio(['v_1']);
    senders[0]!.recusar = () => erro('InvalidStateError');
    await settle(20);
    expect(ctx.mesh.resumoConfigAudio()).toMatchObject({ aplicados: 0, maxBitrate: null });
  });

  it('peer que sai leva junto o registro da configuração', async () => {
    const { ctx } = await comAudio(['v_1', 'v_2']);
    await settle(20);
    ctx.mesh.drop('v_1');
    expect(ctx.mesh.resumoConfigAudio()?.senders).toBe(1);
    ctx.mesh.drop('v_2');
    expect(ctx.mesh.resumoConfigAudio()).toBeNull();
  });
});

describe('MeshTopology — troca de áudio sem renegociar (TELA-012)', () => {
  it('troca, silencia com null, e devolve o som ao mesmo sender', async () => {
    const ctx = build();
    const audio = fakeTrack('audio');
    await ctx.mesh.publish(ctx.stream, [ctx.video, audio], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle(20);
    const pc = ctx.factory.created[0] as FakePeerConnection;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'audio')!;
    const trocas: (MediaStreamTrack | null)[] = [];
    (sender as unknown as { replaceTrack: (t: MediaStreamTrack | null) => Promise<void> }).replaceTrack =
      async (t) => {
        trocas.push(t);
        (sender as unknown as { track: MediaStreamTrack | null }).track = t;
      };

    const nova = fakeTrack('audio');
    expect(await ctx.mesh.replaceAudio(nova, ctx.stream)).toBe(true);
    expect(await ctx.mesh.replaceAudio(null, ctx.stream)).toBe(true);
    const volta = fakeTrack('audio');
    expect(await ctx.mesh.replaceAudio(volta, ctx.stream)).toBe(true);
    expect(trocas).toEqual([nova, null, volta]);
  });

  it('sem sender de áudio, avisa que é preciso publicar', async () => {
    const ctx = build();
    await ctx.mesh.publish(ctx.stream, [ctx.video], PRESET_1080P60);
    ctx.mesh.admit('v_1');
    await settle(20);
    expect(await ctx.mesh.replaceAudio(fakeTrack('audio'), ctx.stream)).toBe(false);
  });
});
