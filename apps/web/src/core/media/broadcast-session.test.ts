import { beforeEach, describe, expect, it } from 'vitest';
import { CONTENT_HINT } from '@tela/shared';
import {
  FakeAudioCapture,
  FakeAudioGain,
  FakeMediaTransport,
  FakeScheduler,
  FakeScreenCapture,
  createStream,
  shareUrlFor,
} from '../testing/fakes.js';
import { BroadcastSession } from './broadcast-session.js';
import { PRESETS, PRESET_IDS } from './presets.js';

const SLUG = 'joao';
const TOKEN = 'o'.repeat(43);
const settle = async (times = 12) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

function build() {
  const transport = new FakeMediaTransport();
  const screen = new FakeScreenCapture();
  const audio = new FakeAudioCapture();
  const gain = new FakeAudioGain();
  const scheduler = new FakeScheduler();

  const session = new BroadcastSession({
    transport,
    screen,
    audio,
    gain,
    scheduler,
    shareUrlFor,
    createStream,
    statsIntervalMs: 1_000,
  });

  const seen: string[] = [];
  session.subscribe(() => seen.push(session.getState().status));

  return { transport, screen, audio, scheduler, session, seen };
}

describe('BroadcastSession — caminho feliz', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  it('percorre idle → requesting-capture → connecting → live', async () => {
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.seen).toEqual(['requesting-capture', 'connecting', 'live']);
  });

  it('marca contentHint=motion — a linha que decide se o produto presta', async () => {
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.screen.video.contentHint).toBe(CONTENT_HINT);
  });

  it('reivindica o canal com o slug e o token do dono', async () => {
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.transport.hosted).toEqual({ slug: SLUG, ownerToken: TOKEN });
  });

  it('publica o vídeo com o preset escolhido', async () => {
    await ctx.session.start(SLUG, TOKEN, { presetId: 'p720p60' });
    expect(ctx.transport.videos).toHaveLength(1);
    // 5,5 Mbps e não 4: a escada foi recalibrada por bits por pixel, e 720p60
    // a 4 Mbps entregava 0,072 bpp — abaixo do que movimento alto exige.
    expect(ctx.transport.videos[0]?.preset.main.maxBitrate).toBe(6_000_000);
  });

  it('pede captura na resolução e no framerate do preset', async () => {
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.screen.lastRequest).toMatchObject({ width: 1920, height: 1080, frameRate: 60 });
  });

  it('emite started para a UI copiar o link', async () => {
    const links: string[] = [];
    ctx.session.on('started', ({ shareUrl }) => links.push(shareUrl));
    await ctx.session.start(SLUG, TOKEN);
    expect(links).toEqual([`https://tela.gg/${SLUG}`]);
  });
});

describe('BroadcastSession — falhas', () => {
  it('preserva diagnóstico de falha de captura sem amostra e o reinicia na sessão seguinte', async () => {
    const ctx = build();
    ctx.screen.denied = true;
    await ctx.session.start(SLUG, TOKEN);
    const falha = ctx.session.diagnostico('Chrome/127');
    expect(falha?.eventos.at(-1)).toMatchObject({
      etapa: 'capture', codigo: 'CAPTURE_DENIED',
    });
    expect(falha?.amostras).toEqual([]);
    ctx.screen.denied = false;
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.session.diagnostico('Chrome/127')?.sessaoId).not.toBe(falha?.sessaoId);
  });

  it('captura negada termina em CAPTURE_DENIED sem tocar no canal', async () => {
    const ctx = build();
    ctx.screen.denied = true;
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'CAPTURE_DENIED' });
    expect(ctx.transport.hosted).toBeNull();
  });

  it('browser sem getDisplayMedia termina em CAPTURE_UNSUPPORTED', async () => {
    const ctx = build();
    ctx.screen.supported = false;
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'CAPTURE_UNSUPPORTED' });
  });

  it('slug de outra pessoa termina em SLUG_TAKEN e solta a captura', async () => {
    const ctx = build();
    ctx.transport.hostError = { code: 'SLUG_TAKEN' };
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'SLUG_TAKEN' });
    expect(ctx.screen.video.stopped).toBe(true);
  });

  it('OWNER_INVALID vira SLUG_TAKEN — a ação do usuário é a mesma', async () => {
    const ctx = build();
    ctx.transport.hostError = { code: 'OWNER_INVALID' };
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'SLUG_TAKEN' });
  });

  it('erro desconhecido vira SIGNALING_UNAVAILABLE', async () => {
    const ctx = build();
    ctx.transport.hostError = new Error('boom');
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'SIGNALING_UNAVAILABLE' });
  });

  it('usuário parando pelo controle nativo do browser encerra a sessão', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.screen.video.fireEnded();
    await settle();
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'CAPTURE_ENDED' });
  });

  it('start duplicado é ignorado enquanto já está ao vivo', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.transport.videos).toHaveLength(1);
  });
});

describe('BroadcastSession — espectadores', () => {
  it('reflete a malha reportada pelo transporte', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.setPeers([
      { id: 'v_1', connectionState: 'connected', usingRelay: false },
      { id: 'v_2', connectionState: 'connected', usingRelay: true },
    ]);

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.peers).toHaveLength(2);
    expect(ctx.session.viewerCount).toBe(2);
  });

  it('expõe quem está passando por relay para a UI poder avisar', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.setPeers([{ id: 'v_1', connectionState: 'connected', usingRelay: true }]);

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.peers.filter((p) => p.usingRelay)).toHaveLength(1);
  });
});

describe('BroadcastSession — qualidade', () => {
  it('troca de preset ao vivo NÃO republica — só ajusta os senders', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPreset('p480p60');

    // Republicar renegociaria e faria todo mundo piscar.
    expect(ctx.transport.videos).toHaveLength(1);
    expect(ctx.transport.presets.at(-1)?.id).toBe('p480p60');
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p480p60');
  });

  it('trocar para o mesmo preset não faz nada', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPreset('p1080p60');
    expect(ctx.transport.presets).toHaveLength(0);
  });

  it('pressão de CPU sustentada desce um degrau e marca como forçado', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.stats = {
      fps: 42,
      bitrateBps: 5_000_000,
      rttMs: 30,
      limitation: 'cpu',
      width: 1920,
      height: 1080,
      availableBps: null,
      bpp: 0.1,
      encoderImplementation: null,
      qp: null,
      msPorQuadro: null,
      recepcao: null,
      piorAvailableBps: null,
      paresMedidos: 1,
      availablePorPeer: {},
    };

    // Aquecimento (8) mais a sequência de pressão (5).
    for (let i = 0; i < 14; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }

    const state = ctx.session.getState();
    // Um degrau abaixo de 1080p60 é 900p60 desde a recalibração — a escada
    // ganhou degraus intermediários para cair sem despencar.
    expect(state.status === 'live' && state.presetId).toBe('p900p60');
    expect(state.status === 'live' && state.presetForced).toBe(true);
  });

  it('uma leitura isolada com cpu NÃO derruba o preset', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    const base = { fps: 55, bitrateBps: 7_000_000, rttMs: 30, width: 1920, height: 1080, availableBps: null, bpp: 0.1, encoderImplementation: null, qp: null, msPorQuadro: null, recepcao: null, piorAvailableBps: null, paresMedidos: 1, availablePorPeer: {} };

    ctx.transport.stats = { ...base, limitation: 'cpu' };
    for (let i = 0; i < 10; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }

    ctx.transport.stats = { ...base, limitation: 'none' };
    for (let i = 0; i < 14; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p1080p60');
  });

  it('a escada de CPU anda e nunca chega a 30fps', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN, { presetId: 'p480p60' });
    ctx.transport.stats = {
      fps: 20,
      bitrateBps: 2_000_000,
      rttMs: 30,
      limitation: 'cpu',
      width: 1280,
      height: 720,
      availableBps: null,
      bpp: 0.1,
      encoderImplementation: null,
      qp: null,
      msPorQuadro: null,
      recepcao: null,
      piorAvailableBps: null,
      paresMedidos: 1,
      availablePorPeer: {},
    };

    for (let i = 0; i < 30; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }

    /**
     * A escada agora ANDA até o piso — antes parava um degrau antes, porque o
     * degrau seguinte tinha a mesma resolução e só cortaria framerate. Com a
     * tabela recalibrada cada degrau tira pixel, então descer sempre alivia o
     * encoder. O que continua valendo é o outro lado da regra: nem o piso
     * abre mão dos 60fps.
     */
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p360p60');
  });

  it('escolha manual limpa a marca de forçado', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPreset('p720p60');
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetForced).toBe(false);
  });
});

describe('BroadcastSession — não atrapalhar o jogo', () => {
  const amostra = (extra: Record<string, unknown>) => ({
    fps: 60,
    bitrateBps: 7_000_000,
    rttMs: 30,
    width: 1920,
    height: 1080,
    limitation: 'none' as const,
    availableBps: null,
    bpp: 0.1,
    encoderImplementation: null,
    qp: null,
    msPorQuadro: null,
    recepcao: null,
    paresMedidos: 1,
    ...extra,
    // Um espectador só, por padrão: o pior é o único. Um teste que queira
    // simular o amigo em ADSL sobrescreve `piorAvailableBps` explicitamente.
    piorAvailableBps:
      (extra['piorAvailableBps'] as number | null | undefined) ??
      (extra['availableBps'] as number | null | undefined) ??
      null,
    /*
      O governador suaviza CADA caminho e depois tira o mínimo, então ele
      precisa das leituras cruas por peer. Por padrão um espectador só, com o
      valor de `availableBps`; um teste que queira simular o amigo em ADSL
      passa `availablePorPeer` explicitamente.
    */
    availablePorPeer:
      (extra['availablePorPeer'] as Record<string, number> | undefined) ??
      (typeof extra['availableBps'] === 'number' ? { v_1: extra['availableBps'] } : {}),
  });

  /** Avança N leituras de estatística de um segundo cada. */
  async function tique(ctx: ReturnType<typeof build>, vezes: number) {
    for (let i = 0; i < vezes; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }
  }

  it('captura cai para 5fps depois de um tempo de graça sem espectador', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    ctx.transport.setPeers([]);
    await settle();
    // A graça existe porque um peer some por um instante em toda
    // renegociação, e derrubar a captura a cada piscada é a travadinha que a
    // otimização deveria evitar.
    expect(ctx.screen.video.constraints.at(-1)).toBeUndefined();

    ctx.scheduler.advance(11_000);
    ctx.transport.setPeers([]);
    await settle();
    expect(ctx.screen.video.constraints.at(-1)).toMatchObject({ frameRate: 5 });
  });

  it('peer que pisca NÃO derruba a captura', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    const peer = [{ id: 'v_1', connectionState: 'connected' as const, usingRelay: false }];

    for (let i = 0; i < 5; i += 1) {
      ctx.transport.setPeers([]);
      await settle();
      ctx.scheduler.advance(2_000);
      ctx.transport.setPeers(peer);
      await settle();
    }

    expect(ctx.screen.video.constraints).toEqual([]);
  });

  it('captura volta ao framerate cheio quando alguém entra', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    ctx.transport.setPeers([]);
    await settle();
    ctx.scheduler.advance(11_000);
    ctx.transport.setPeers([]);
    await settle();
    expect(ctx.screen.video.constraints.at(-1)).toMatchObject({ frameRate: 5 });

    ctx.transport.setPeers([{ id: 'v_1', connectionState: 'connected', usingRelay: false }]);
    await settle();
    expect(ctx.screen.video.constraints.at(-1)).toMatchObject({ frameRate: 60 });
  });

  it('o throttle de ociosidade NÃO descarta as constraints de resolução', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    /*
      `applyConstraints` SUBSTITUI o conjunto inteiro; não faz merge. Mandar só
      `{ frameRate }` apagava `width`, `height` e `resizeMode`, e a captura
      voltava para a resolução NATIVA do monitor.

      Não é canto raro: toda transmissão começa sem espectador, cai para 5fps
      em dez segundos e volta quando o primeiro amigo entra. A partir daí um
      monitor 1440p ou 4K entregava quadros nativos 60 vezes por segundo, na
      mesma máquina que roda o jogo — que é exatamente o custo que o
      `crop-and-scale` existe para evitar.
    */
    ctx.scheduler.advance(11_000);
    await settle(4);
    ctx.scheduler.advance(1_000);
    await settle(4);

    const aplicadas = ctx.screen.video.constraints.at(-1) as Record<string, unknown>;
    expect(aplicadas['resizeMode']).toBe('crop-and-scale');
    expect(aplicadas['width']).toMatchObject({ max: 1920 });
    expect(aplicadas['height']).toMatchObject({ max: 1080 });
  });

  it('RUÍDO na estimativa de banda não reconfigura o encoder', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    /*
      Banda de sobra, oscilando ±20%.

      MUDANÇA DE CONTRATO (ADR 0017): a expectativa era ZERO reconfigurações,
      porque o governador calava quando não havia o que restringir. Esse
      silêncio era o defeito — quem o consumia caía no nominal do preset, e um
      link de 800 Mbps entregava 12 Mbps.

      Agora ele reporta o orçamento UMA vez, quando o aquecimento termina, e a
      histerese absorve todo o resto. Uma reconfiguração no início da
      transmissão é o preço de gastar a banda que existe; catorze, uma por
      segundo, era o travamento que os usuários relataram.
    */
    const ruido = [16, 14, 17, 13, 18, 12, 16, 15, 17, 14, 16, 15, 17, 13];
    for (const mbps of ruido) {
      ctx.transport.stats = amostra({ availableBps: mbps * 1_000_000 });
      await tique(ctx, 1);
    }

    expect(ctx.transport.ceilings).toHaveLength(1);
  });

  it('banda APERTADA e oscilando reconfigura UMA vez, não a cada segundo', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    // A versão anterior aplicava 75% do valor CRU a cada segundo — o encoder
    // recebia um alvo diferente por segundo e nunca assentava. Foi
    // exatamente isso que os usuários relataram como travamento.
    const ruido = [5.5, 4.6, 5.3, 4.8, 5.6, 4.5, 5.2, 4.9, 5.4, 4.7, 5.1, 5.0, 5.3, 4.8, 5.2, 4.9];
    for (const mbps of ruido) {
      ctx.transport.stats = amostra({ availableBps: mbps * 1_000_000 });
      await tique(ctx, 1);
    }

    expect(ctx.transport.ceilings.length).toBeLessThanOrEqual(1);
  });

  it('queda REAL e sustentada de banda aplica teto com folga', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.stats = amostra({ availableBps: 4_000_000 });
    await tique(ctx, 20);

    const teto = ctx.transport.ceilings.at(-1);
    expect(teto).toBeGreaterThan(0);
    // Os 25% de folga são a diferença entre transmitir e estrangular o jogo.
    expect(teto).toBeLessThanOrEqual(4_000_000 * 0.8);
  });

  it('limitação por BANDA derruba o preset, não só por CPU', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.stats = amostra({ limitation: 'bandwidth' });

    // Aquecimento mais a sequência de pressão.
    await tique(ctx, 14);

    const state = ctx.session.getState();
    // Um degrau abaixo de 1080p60 passou a ser 900p60: a escada recalibrada
    // ganhou degraus intermediários, então cair não é mais despencar.
    expect(state.status === 'live' && state.presetId).toBe('p900p60');
    expect(state.status === 'live' && state.presetForced).toBe(true);
  });

  it('aperto no INÍCIO da transmissão não degrada nada', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.stats = amostra({ limitation: 'cpu' });

    // No começo o encoder ainda está subindo e o estimador ainda está
    // sondando: `cpu` aparece por alguns segundos mesmo em máquina folgada.
    await tique(ctx, 7);

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p1080p60');
  });

  it('alternar entre limitadores não acumula pressão indevida', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    for (let i = 0; i < 20; i += 1) {
      ctx.transport.stats = amostra({ limitation: i % 2 === 0 ? 'cpu' : 'bandwidth' });
      await tique(ctx, 1);
    }

    // Nenhum dos dois chegou a cinco leituras seguidas.
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p1080p60');
  });
});

/**
 * O defeito central da ADR 0015, exercitado ponta a ponta.
 *
 * O relato que o motivou: transmissão a 58ms de RTT, dois espectadores, e a
 * imagem BORRADA — não quadriculada. Borrada é resolução baixa esticada, e a
 * causa era o teto de upload apertar bits sem tirar um pixel sequer.
 */
describe('BroadcastSession — o teto de upload escolhe o DEGRAU', () => {
  const amostra = (extra: Record<string, unknown>) => ({
    fps: 60,
    bitrateBps: 7_000_000,
    rttMs: 58,
    width: 1920,
    height: 1080,
    limitation: 'none' as const,
    availableBps: null,
    bpp: 0.1,
    encoderImplementation: null,
    qp: null,
    msPorQuadro: null,
    recepcao: null,
    paresMedidos: 1,
    ...extra,
    // Um espectador só, por padrão: o pior é o único. Um teste que queira
    // simular o amigo em ADSL sobrescreve `piorAvailableBps` explicitamente.
    piorAvailableBps:
      (extra['piorAvailableBps'] as number | null | undefined) ??
      (extra['availableBps'] as number | null | undefined) ??
      null,
    /*
      O governador suaviza CADA caminho e depois tira o mínimo, então ele
      precisa das leituras cruas por peer. Por padrão um espectador só, com o
      valor de `availableBps`; um teste que queira simular o amigo em ADSL
      passa `availablePorPeer` explicitamente.
    */
    availablePorPeer:
      (extra['availablePorPeer'] as Record<string, number> | undefined) ??
      (typeof extra['availableBps'] === 'number' ? { v_1: extra['availableBps'] } : {}),
  });

  async function tique(ctx: ReturnType<typeof build>, vezes: number) {
    for (let i = 0; i < vezes; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }
  }

  it('orçamento apertado DERRUBA a resolução, não só o bitrate', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    // 4 Mbps por espectador → teto de 3 Mbps. Antes, o degrau ficava em
    // 1080p60 e o encoder recebia 1920×1080@60 para caber em 0,024 bpp.
    ctx.transport.stats = amostra({ availableBps: 4_000_000 });
    await tique(ctx, 20);

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).not.toBe('p1080p60');
    expect(state.status === 'live' && state.presetForced).toBe(true);
    expect(state.status === 'live' && state.motivoDegradacao).toBe('bandwidth');
  });

  it('o degrau escolhido mantém os bits por pixel acima do piso', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.stats = amostra({ availableBps: 4_000_000 });
    await tique(ctx, 20);

    const state = ctx.session.getState();
    const id = state.status === 'live' ? state.presetId : 'p1080p60';
    const { width, height } = PRESETS[id];
    const teto = ctx.transport.ceilings.at(-1) ?? 0;

    // A conta que a foto do relato reprovava: 3 Mbps em 1080p60 dão 0,024.
    expect(teto / (width * height * 60)).toBeGreaterThanOrEqual(0.1);
  });

  it('banda de sobra não derruba degrau nenhum', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    // 20 Mbps por espectador: o 1080p60 cabe inteiro, com folga.
    ctx.transport.stats = amostra({ availableBps: 20_000_000 });
    await tique(ctx, 20);

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p1080p60');
    expect(state.status === 'live' && state.presetForced).toBe(false);
  });

  it('800 Mbps de subida chegam ao encoder em vez de parar em 12 (ADR 0017)', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    // O relato: link de 800 Mbps, dois espectadores, imagem ruim. O orçamento
    // por espectador é 300 Mbps e o encoder recebia os 12 Mbps do rótulo,
    // porque nenhum teto era aplicado e ninguém media a banda que sobrava.
    ctx.transport.stats = amostra({ availableBps: 800_000_000 });
    await tique(ctx, 20);

    const orcamento = ctx.transport.ceilings.at(-1);
    expect(orcamento).not.toBeNull();
    expect(orcamento!).toBeGreaterThan(100_000_000);

    // E o degrau continua no topo: banda de sobra não é motivo para descer.
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p1080p60');
  });

  it('a banda voltando devolve o degrau — o "embaçou e não voltou"', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    ctx.transport.stats = amostra({ availableBps: 4_000_000 });
    await tique(ctx, 20);
    const fundo = ctx.session.getState();
    expect(fundo.status === 'live' && fundo.presetId).not.toBe('p1080p60');

    // O vizinho parou de baixar o jogo dele.
    ctx.transport.stats = amostra({ availableBps: 30_000_000 });
    await tique(ctx, 40);

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p1080p60');
    expect(state.status === 'live' && state.presetForced).toBe(false);
    expect(state.status === 'live' && state.motivoDegradacao).toBeNull();
  });

  it('a recuperação por CPU NÃO fica travada por um teto em vigor', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    // Um transiente de CPU derruba a escada de pressão…
    ctx.transport.stats = amostra({ limitation: 'cpu' });
    await tique(ctx, 14);
    expect(ctx.session.getState().status === 'live').toBe(true);

    // …e a banda fica APERTADA mas estável. Antes, `governor.ceiling !== null`
    // zerava a calmaria a cada leitura e a escada nunca subia de volta: uma
    // degradação por CPU virava permanente pelo resto da sessão.
    ctx.transport.stats = amostra({ availableBps: 8_000_000, limitation: 'none' });
    await tique(ctx, 130);

    // O degrau volta para o que o orçamento paga — e não para o fundo do poço.
    const state = ctx.session.getState();
    const id = state.status === 'live' ? state.presetId : 'p360p60';
    // 8 × 0,75 = 6,0 Mbps. Na curva do mercado 720p60 exige 6,24 e 576p60
    // exige 4,27 — o degrau honesto para esse orçamento é o 576p60.
    expect(PRESET_IDS.indexOf(id)).toBeLessThanOrEqual(PRESET_IDS.indexOf('p600p60'));
  });

  it('o orçamento não some quando o usuário troca a qualidade na mão', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.stats = amostra({ availableBps: 4_000_000 });
    await tique(ctx, 20);

    // Insistir em 1080p60 não faz o link crescer. O produto obedece o rótulo,
    // mas não pode voltar a mandar 0,024 bpp — seria a foto do relato de novo.
    await ctx.session.setPreset('p1080p60');
    await tique(ctx, 2);

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).not.toBe('p1080p60');
    expect(state.status === 'live' && state.presetForced).toBe(true);
  });

  it('banda NÃO é contada duas vezes: governador e escada não se somam', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    /*
      O Chromium reporta `bandwidth` justamente porque o teto está segurando o
      encoder — é a malha funcionando, não um segundo problema. Deixar a escada
      de pressão reagir a isso derrubava o degrau de novo a cada cinco
      leituras, até o fundo da escada, com o link inalterado.
    */
    ctx.transport.stats = amostra({ availableBps: 8_000_000, limitation: 'bandwidth' });
    await tique(ctx, 60);

    // 8 Mbps por espectador pagam 720p60 com folga. Sem a guarda, sessenta
    // leituras de `bandwidth` teriam levado o degrau até 360p60.
    const state = ctx.session.getState();
    const id = state.status === 'live' ? state.presetId : 'p360p60';
    // 8 × 0,75 = 6,0 Mbps. Na curva do mercado 720p60 exige 6,24 e 576p60
    // exige 4,27 — o degrau honesto para esse orçamento é o 576p60.
    expect(PRESET_IDS.indexOf(id)).toBeLessThanOrEqual(PRESET_IDS.indexOf('p600p60'));
  });

  it('sem estimativa de banda, a escada continua sendo a única defesa', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    // Navegador que não reporta `availableOutgoingBitrate`: o governador não
    // tem o que medir, não aplica teto, e a guarda acima não pode desligar a
    // única malha que sobrou.
    ctx.transport.stats = amostra({ availableBps: null, limitation: 'bandwidth' });
    await tique(ctx, 14);

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p900p60');
  });

  it('a causa da queda por CPU sobrevive ao fim do aperto', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    ctx.transport.stats = amostra({ limitation: 'cpu' });
    await tique(ctx, 14);
    expect(ctx.session.getState()).toMatchObject({ motivoDegradacao: 'cpu' });

    // O aperto passou, mas o degrau só volta depois de 60 amostras de calmaria.
    // Nesse intervalo o motivo lido de `pressureKind` já era `none`, e o
    // fallback dizia "banda" — mandando a pessoa procurar no roteador um
    // problema que estava no encoder.
    ctx.transport.stats = amostra({ limitation: 'none' });
    await tique(ctx, 5);
    expect(ctx.session.getState()).toMatchObject({ motivoDegradacao: 'cpu' });
  });

  it('nitidez sobe a resolução pelos MESMOS bits, cortando quadros', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.stats = amostra({ availableBps: 4_000_000 });
    await tique(ctx, 20);

    const fluido = ctx.session.getState();
    const antes = fluido.status === 'live' ? fluido.presetId : 'p360p60';

    await ctx.session.setPrioridade('nitidez');
    await tique(ctx, 2);

    // A 30fps o mesmo orçamento paga o dobro de bits por pixel, então cabe um
    // degrau maior. Nenhum bit a mais sai do link.
    const nitido = ctx.session.getState();
    const depois = nitido.status === 'live' ? nitido.presetId : 'p360p60';
    expect(PRESET_IDS.indexOf(depois)).toBeLessThan(PRESET_IDS.indexOf(antes));
  });

  it('a recuperação de CPU anda mesmo sob pressão de banda contínua', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    // Cai por CPU.
    ctx.transport.stats = amostra({ limitation: 'cpu', availableBps: 8_000_000 });
    await tique(ctx, 14);
    const fundo = ctx.session.getState();
    const antes = fundo.status === 'live' ? fundo.presetId : 'p360p60';
    expect(antes).not.toBe('p1080p60');

    /*
      A CPU se resolveu, mas o Chromium reporta `bandwidth` de forma contínua
      — porque o orçamento ESTÁ segurando o encoder, ou seja, a malha está
      funcionando. A primeira versão da guarda retornava antes de chamar
      `recuperar()`, então a calmaria congelava e a queda por CPU virava
      permanente, com o degrau abaixo do que o link pagava.

      Subir aqui é seguro: `aplicarDegrau()` corta no orçamento, então nem um
      bit a mais sai do link.
    */
    ctx.transport.stats = amostra({ limitation: 'bandwidth', availableBps: 8_000_000 });
    await tique(ctx, 130);

    const depois = ctx.session.getState();
    const id = depois.status === 'live' ? depois.presetId : 'p360p60';
    expect(PRESET_IDS.indexOf(id)).toBeLessThan(PRESET_IDS.indexOf(antes));
  });

  it('o contentHint acompanha a prioridade — a metade que faltava', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.screen.video.contentHint).toBe('motion');

    await ctx.session.setPrioridade('nitidez');
    expect(ctx.screen.video.contentHint).toBe('detail');

    await ctx.session.setPrioridade('fluidez');
    expect(ctx.screen.video.contentHint).toBe('motion');
  });
});

/**
 * ADR 0018 — os achados da revisão adversarial do pipeline.
 */
describe('BroadcastSession — o pior caminho é quem manda', () => {
  const amostra = (extra: Record<string, unknown>) => ({
    fps: 60,
    bitrateBps: 7_000_000,
    rttMs: 30,
    width: 1920,
    height: 1080,
    limitation: 'none' as const,
    availableBps: null,
    bpp: 0.1,
    encoderImplementation: null,
    qp: null,
    msPorQuadro: null,
    recepcao: null,
    paresMedidos: 1,
    piorAvailableBps: null,
    availablePorPeer: {},
    ...extra,
  });

  async function tique(ctx: ReturnType<typeof build>, vezes: number) {
    for (let i = 0; i < vezes; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }
  }

  it('o amigo em ADSL puxa TODO MUNDO para baixo, não a média', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    /*
      Espectador A em fibra (60 Mbps), espectador B em ADSL (5 Mbps).
      A média dá 32,5 Mbps e manda 24 Mbps para os DOIS — B recebe 24 Mbps num
      cano de 5, ~80% de perda contínua, quadriculado permanente. E não
      converge: quando a estimativa de B desaba, a média mal se mexe.

      Pela R5 todos os senders recebem o MESMO `maxBitrate`, então o número
      correto sempre foi o mínimo. A ADR 0017 declarava isso e o código fazia
      o oposto.
    */
    ctx.transport.stats = amostra({
      availableBps: 65_000_000,
      paresMedidos: 2,
      availablePorPeer: { fibra: 60_000_000, adsl: 5_000_000 },
    });
    await tique(ctx, 20);

    const orcamento = ctx.transport.ceilings.at(-1) ?? 0;
    expect(orcamento).toBeLessThanOrEqual(5_000_000);
    expect(orcamento).toBeGreaterThan(0);
  });

  it('peer que ainda CONECTA não dilui o orçamento de quem já mede', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    /*
      `availableBps` só soma pares ICE nominados; `peers.length` contava também
      quem estava em `connecting`. Numerador e denominador fora de fase: cinco
      amigos clicando juntos num "vem ver" subestimavam o orçamento em até 5×
      no pior instante — e pela catraca da ADR 0018 a transmissão morava lá.
    */
    ctx.transport.setPeers(
      Array.from({ length: 5 }, (_, i) => ({
        id: `v_${i}`,
        connectionState: 'connecting' as RTCPeerConnectionState,
        usingRelay: false,
      })),
    );
    /*
      O divisor sumiu junto com a média: o governador guarda uma média móvel
      POR PEER e tira o mínimo delas. Quem ainda não reportou simplesmente não
      aparece no mapa — não há como diluir.
    */
    ctx.transport.stats = amostra({
      availableBps: 40_000_000,
      paresMedidos: 1,
      availablePorPeer: { v_0: 40_000_000 },
    });
    await tique(ctx, 20);

    // Um par mediu 40 Mbps: o orçamento é ~30, não ~6.
    expect(ctx.transport.ceilings.at(-1) ?? 0).toBeGreaterThan(20_000_000);
  });

  it('um blip de CPU não zera a calmaria da recuperação', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    ctx.transport.stats = amostra({ limitation: 'cpu' });
    await tique(ctx, 14);
    const fundo = ctx.session.getState();
    const antes = fundo.status === 'live' ? fundo.presetId : 'p360p60';
    expect(antes).not.toBe('p1080p60');

    /*
      Descer exige 5 amostras seguidas; subir exigia 60 CONSECUTIVAS, e
      qualquer leitura de aperto zerava o contador. Um `cpu` isolado é rotina —
      keyframe, troca de cena, alt-tab. Com 10% de leituras assim, o tempo
      médio para recuperar UM degrau ia de 60 segundos para 92 minutos.
      Decaindo, um blip custa dez amostras em vez de todas.
    */
    // 10% de blips isolados. Saldo: (9 limpas − 5 de penalidade) = +4 por
    // dezena, então 200 amostras rendem 80 — acima das 60 de um degrau.
    for (let i = 0; i < 200; i += 1) {
      ctx.transport.stats = amostra({ limitation: i % 10 === 0 ? 'cpu' : 'none' });
      await tique(ctx, 1);
    }

    const depois = ctx.session.getState();
    const id = depois.status === 'live' ? depois.presetId : 'p360p60';
    expect(PRESET_IDS.indexOf(id)).toBeLessThan(PRESET_IDS.indexOf(antes));
  });
});

describe('BroadcastSession — trocar a fonte não deixa lixo', () => {
  it('para a trilha de ÁUDIO da nova captura em vez de vazá-la', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    const antes = ctx.screen.audios.length;
    await ctx.session.switchSource();
    await settle();

    /*
      A requisição pede `systemAudio: true` e no Windows vem áudio junto. Ela
      só era parada no ramo de corrida perdida; no caminho feliz ninguém
      parava nem usava. Alternar jogo → navegador → jogo três vezes deixava
      três capturas de som do sistema vivas na máquina do jogo.
    */
    const novas = ctx.screen.audios.slice(antes);
    for (const trilha of novas) expect(trilha.stopped).toBe(true);
  });

  it('trocar a fonte rearma o throttle de ociosidade', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    // Dez segundos sozinho: a captura cai para 5fps.
    ctx.scheduler.advance(11_000);
    await settle(4);
    ctx.scheduler.advance(1_000);
    await settle(4);
    expect(ctx.screen.video.constraints.at(-1)).toMatchObject({ frameRate: 5 });

    /*
      A trilha nova nasce a 60fps, mas `capturaOciosa` continuava `true` e o
      `if (this.capturaOciosa) return` de `throttleIdleCapture` bloqueava a
      reaplicação — 1920×1080@60 permanente sem ninguém assistindo, o oposto
      do que o modo ocioso existe para fazer.
    */
    await ctx.session.switchSource();
    await settle();
    ctx.scheduler.advance(11_000);
    await settle(4);
    ctx.scheduler.advance(1_000);
    await settle(4);

    const nova = ctx.screen.video;
    expect(nova.constraints.at(-1)).toMatchObject({ frameRate: 5 });
  });
});

describe('BroadcastSession — colapso de link não pode calar as duas malhas', () => {
  const amostra = (extra: Record<string, unknown>) => ({
    fps: 60,
    bitrateBps: 7_000_000,
    rttMs: 40,
    width: 1920,
    height: 1080,
    limitation: 'none' as const,
    availableBps: null,
    bpp: 0.1,
    encoderImplementation: null,
    qp: null,
    msPorQuadro: null,
    recepcao: null,
    paresMedidos: 1,
    piorAvailableBps: null,
    availablePorPeer: {},
    ...extra,
  });

  async function tique(ctx: ReturnType<typeof build>, vezes: number) {
    for (let i = 0; i < vezes; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }
  }

  /**
   * DEFEITO CONHECIDO, e este teste existe para não deixar esquecer.
   *
   * `it.fails` afirma que ele REPROVA hoje. No dia em que alguém consertar o
   * caso, este teste passa a passar e o vitest acusa — que é exatamente o
   * lembrete que se quer. Apagá-lo esconderia o defeito; deixá-lo verde
   * mentiria; deixá-lo vermelho ensinaria a ignorar o vermelho.
   *
   * Ver o bloco em `broadcast-session.ts` sobre as duas guardas: três consertos
   * foram tentados e MEDIDOS, e os três pioraram de uma a duas ordens de
   * grandeza o que o simulador consegue medir.
   */
  it.fails('o link despencando DERRUBA o orçamento, mesmo com o envio caindo junto', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    // Link farto: o orçamento sobe e o degrau fica no topo.
    ctx.transport.stats = amostra({
      availableBps: 27_000_000,
      bitrateBps: 20_000_000,
      availablePorPeer: { v_1: 27_000_000 },
    });
    await tique(ctx, 30);
    const gordo = ctx.transport.ceilings.at(-1) ?? 0;
    expect(gordo).toBeGreaterThan(15_000_000);

    /*
      O link colapsa. O WebRTC entrega `min(BWE, maxBitrate)` ao encoder, então
      o ENVIO cai junto — e a guarda de "cena parada", que existe para não
      cortar quando o encoder simplesmente não tem o que codificar, tratava os
      dois casos como o mesmo. O corte ficava bloqueado indefinidamente:
      medido, 300s com o orçamento congelado em 20,25 Mbps num cano de 2,7, o
      degrau parado em 1080p60 e `motivoDegradacao` em `null`. 0,0217 bpp, e a
      tela não dizia nada.
    */
    ctx.transport.stats = amostra({
      availableBps: 2_700_000,
      bitrateBps: 2_000_000,
      availablePorPeer: { v_1: 2_700_000 },
    });
    await tique(ctx, 60);

    const magro = ctx.transport.ceilings.at(-1) ?? 0;
    expect(magro).toBeLessThan(gordo / 2);

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).not.toBe('p1080p60');
  });

  it('cena parada de VERDADE ainda não derruba o orçamento', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.stats = amostra({
      availableBps: 27_000_000,
      bitrateBps: 20_000_000,
      availablePorPeer: { v_1: 27_000_000 },
    });
    await tique(ctx, 30);
    const antes = ctx.transport.ceilings.at(-1) ?? 0;

    /*
      O encoder para de consumir porque não há o que codificar, mas a
      ESTIMATIVA não se move — é isso que distingue do colapso. O orçamento tem
      que ficar de pé para o movimento voltar sem passar por uma queda de
      degrau que não era necessária.
    */
    ctx.transport.stats = amostra({
      availableBps: 27_000_000,
      bitrateBps: 1_000_000,
      availablePorPeer: { v_1: 27_000_000 },
    });
    await tique(ctx, 15);

    expect(ctx.transport.ceilings.at(-1) ?? 0).toBeGreaterThanOrEqual(antes * 0.9);
  });
});

describe('BroadcastSession — nitidez que vira slideshow volta atrás', () => {
  const amostra = (extra: Record<string, unknown>) => ({
    fps: 60,
    bitrateBps: 3_000_000,
    rttMs: 30,
    width: 1280,
    height: 720,
    limitation: 'none' as const,
    availableBps: null,
    bpp: 0.11,
    encoderImplementation: null,
    qp: null,
    msPorQuadro: null,
    recepcao: null,
    paresMedidos: 1,
    piorAvailableBps: null,
    availablePorPeer: {},
    ...extra,
  });

  async function tique(ctx: ReturnType<typeof build>, vezes: number) {
    for (let i = 0; i < vezes; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }
  }

  it('abaixo de 20fps em nitidez, o modo desiste sozinho', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPrioridade('nitidez');

    /*
      O E2E em browser real mediu `nitidez` a 8 fps no degrau de 360p60: o
      encoder encosta no teto de QP e só lhe resta descartar quadro. E o modo
      põe o `contentHint` em `detail`, que DESLIGA o quality scaler do Chromium
      — a rede de segurança que teria tirado resolução em vez de quadro.

      Oito quadros por segundo não é "nítido a 30fps", é apresentação de slides.
    */
    ctx.transport.stats = amostra({ fps: 8, limitation: 'cpu' });
    await tique(ctx, 16);

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.prioridade).toBe('fluidez');
    expect(ctx.screen.video.contentHint).toBe('motion');
  });

  it('cena PARADA a 8fps não desfaz o modo — é para isso que ele existe', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPrioridade('nitidez');

    /*
      `framesPerSecond` do `outbound-rtp` são quadros ENVIADOS, e captura de
      tela é dirigida a mudança: um mapa, um inventário ou uma planilha
      produzem poucos quadros por segundo com a máquina inteiramente folgada.

      A versão anterior olhava só o fps e desligava `nitidez` em cinco
      segundos — no conteúdo exato para o qual o modo foi criado, e de forma
      circular: reescolher era revertido de novo. O que justifica desistir é o
      encoder NÃO DAR CONTA, e isso `qualityLimitationReason` diz.
    */
    ctx.transport.stats = amostra({ fps: 4, limitation: 'none' });
    await tique(ctx, 30);

    expect(ctx.session.getState()).toMatchObject({ prioridade: 'nitidez' });
  });

  it('nitidez entregando framerate de vídeo é deixada em paz', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPrioridade('nitidez');

    ctx.transport.stats = amostra({ fps: 30 });
    await tique(ctx, 30);

    expect(ctx.session.getState()).toMatchObject({ prioridade: 'nitidez' });
  });

  it('uma queda isolada de fps não desfaz a escolha do usuário', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPrioridade('nitidez');

    for (let i = 0; i < 20; i += 1) {
      ctx.transport.stats = amostra({ fps: i % 5 === 0 ? 8 : 30 });
      await tique(ctx, 1);
    }
    expect(ctx.session.getState()).toMatchObject({ prioridade: 'nitidez' });
  });
});

describe('BroadcastSession — encerramento', () => {
  it('stop solta trilhas, desconecta e cancela timers', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.stop();

    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'USER_STOPPED' });
    expect(ctx.screen.video.stopped).toBe(true);
    expect(ctx.transport.disconnected).toBe(true);
    expect(ctx.scheduler.pending).toBe(0);
  });

  it('não amostra estatística depois de parar', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.stop();
    ctx.scheduler.advance(60_000);
    expect(ctx.session.getState().status).toBe('ended');
  });

  it('queda da MÍDIA encerra a sessão', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.emit('closed', { reason: 'ICE_FAILED' });
    await settle();
    expect(ctx.session.getState().status).toBe('ended');
  });

  it('queda do SERVIDOR não encerra a transmissão', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.setPeers([{ id: 'v_1', connectionState: 'connected', usingRelay: false }]);

    ctx.transport.loseSignaling();
    await settle();

    // A conexão é direta: o servidor nunca esteve no caminho da mídia, então
    // não pode estar no caminho da falha. Derrubar aqui contradizia o README,
    // a regra R8 e a ADR 0005 — e matava tudo em menos de dois segundos.
    const state = ctx.session.getState();
    expect(state.status).toBe('live');
    expect(state.status === 'live' && state.semSinalizacao).toBe(true);
    expect(state.status === 'live' && state.peers).toHaveLength(1);
    expect(ctx.screen.video.stopped).toBe(false);
  });
});

describe('BroadcastSession — trocar fonte e prioridade', () => {
  it('trocar a fonte NÃO renegocia — substitui a trilha nos senders', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    const original = ctx.transport.videos.length;

    await ctx.session.switchSource();

    // Republicar faria todo espectador piscar. `replaceTrack` não toca no SDP.
    expect(ctx.transport.videos).toHaveLength(original);
    expect(ctx.transport.substituidas).toHaveLength(1);
  });

  it('trocar a fonte atualiza o preview', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    const antes = ctx.session.getState();
    await ctx.session.switchSource();
    const depois = ctx.session.getState();

    expect(antes.status === 'live' && depois.status === 'live').toBe(true);
    expect(depois.status === 'live' && depois.preview).not.toBe(
      antes.status === 'live' ? antes.preview : null,
    );
  });

  it('cancelar o seletor desiste da troca, não da transmissão', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.screen.denied = true;

    await ctx.session.switchSource();

    expect(ctx.session.getState().status).toBe('live');
    expect(ctx.transport.substituidas).toHaveLength(0);
  });

  it('prioridade começa em fluidez — 60fps é a regra do produto', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.prioridade).toBe('fluidez');
  });

  it('escolher nitidez segura a resolução e deixa o framerate ceder', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPrioridade('nitidez');

    // Cena carregada a 1080p60 borra de verdade; quem mostra um mapa ou texto
    // prefere nítido a 30fps do que fluido e ilegível.
    expect(ctx.transport.prioridades).toEqual(['nitidez']);
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.prioridade).toBe('nitidez');
  });

  it('escolher a mesma prioridade não reconfigura nada', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPrioridade('fluidez');
    expect(ctx.transport.prioridades).toEqual([]);
  });
});

describe('BroadcastSession — preview da captura', () => {
  it('expõe a mídia capturada para quem transmite conferir', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.preview).not.toBeNull();
  });

  it('o preview leva o vídeo mas NÃO o áudio', async () => {
    const ctx = build();
    ctx.screen.withAudio = true;
    await ctx.session.start(SLUG, TOKEN);

    const state = ctx.session.getState();
    const preview = state.status === 'live' ? state.preview : null;
    // Tocar o áudio do jogo de volta nos alto-falantes de quem está jogando
    // cria eco — e o navegador pode capturar esse eco de volta.
    expect(preview?.getVideoTracks()).toHaveLength(1);
    expect(preview?.getAudioTracks()).toHaveLength(0);
  });

  it('some junto com a sessão', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.stop();
    expect(ctx.session.getState().status).toBe('ended');
  });
});

describe('BroadcastSession — tela inteira', () => {
  it('pede o seletor já na tela inteira', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    // A tela inteira é o caso principal: o jogo está na tela, não numa aba.
    expect(ctx.screen.lastRequest).toMatchObject({ width: 1920, height: 1080 });
  });

  it('escolher janela sem áudio avisa que o som ficou de fora', async () => {
    const ctx = build();
    ctx.screen.withAudio = false;
    ctx.screen.surface = 'window';
    await ctx.session.start(SLUG, TOKEN);

    // O navegador entrega vídeo mudo sem dizer nada; a pessoa só descobre
    // quando um amigo reclama.
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.audioPerdidoPelaEscolha).toBe(true);
  });

  it('tela inteira sem áudio NÃO acusa escolha errada', async () => {
    const ctx = build();
    ctx.screen.withAudio = false;
    ctx.screen.surface = 'monitor';
    await ctx.session.start(SLUG, TOKEN);

    // No Linux a tela inteira também vem sem áudio, e a culpa não é da
    // escolha — acusar aqui seria mandar o usuário refazer algo que já fez.
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.audioPerdidoPelaEscolha).toBe(false);
  });

  it('janela COM áudio não acusa nada', async () => {
    const ctx = build();
    ctx.screen.withAudio = true;
    ctx.screen.surface = 'window';
    await ctx.session.start(SLUG, TOKEN);
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.audioPerdidoPelaEscolha).toBe(false);
  });
});

describe('BroadcastSession — áudio', () => {
  it('usa o áudio do getDisplayMedia quando existe (Windows)', async () => {
    const ctx = build();
    ctx.screen.withAudio = true;
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.transport.audios).toHaveLength(1);
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.hasAudio).toBe(true);
  });

  it('cai para o sink virtual quando o browser não entrega áudio (Linux)', async () => {
    const ctx = build();
    ctx.screen.withAudio = false;
    await ctx.session.start(SLUG, TOKEN, { audioDeviceId: 'monitor-1' });
    expect(ctx.transport.audios).toHaveLength(1);
  });

  it('falha ao capturar áudio transmite mudo em vez de abortar', async () => {
    const ctx = build();
    ctx.audio.fails = true;
    await ctx.session.start(SLUG, TOKEN, { audioDeviceId: 'monitor-1' });
    expect(ctx.session.getState().status).toBe('live');
    expect(ctx.transport.audios).toHaveLength(0);
  });
});
