import { beforeEach, describe, expect, it } from 'vitest';
import { CONTENT_HINT } from '@tela/shared';
import {
  FakeAudioCapture,
  FakeMediaTransport,
  FakeScheduler,
  FakeScreenCapture,
  shareUrlFor,
} from '../testing/fakes.js';
import { BroadcastSession } from './broadcast-session.js';

const SLUG = 'joao';
const TOKEN = 'o'.repeat(43);
const settle = async (times = 12) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

function build() {
  const transport = new FakeMediaTransport();
  const screen = new FakeScreenCapture();
  const audio = new FakeAudioCapture();
  const scheduler = new FakeScheduler();

  const session = new BroadcastSession({
    transport,
    screen,
    audio,
    scheduler,
    shareUrlFor,
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
    expect(ctx.transport.videos[0]?.preset.main.maxBitrate).toBe(4_000_000);
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
    await ctx.session.setPreset('p720p60eco');

    // Republicar renegociaria e faria todo mundo piscar.
    expect(ctx.transport.videos).toHaveLength(1);
    expect(ctx.transport.presets.at(-1)?.id).toBe('p720p60eco');
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p720p60eco');
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
    };

    for (let i = 0; i < 5; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p720p60');
    expect(state.status === 'live' && state.presetForced).toBe(true);
  });

  it('uma leitura isolada com cpu NÃO derruba o preset', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    const base = { fps: 55, bitrateBps: 7_000_000, rttMs: 30, width: 1920, height: 1080, availableBps: null };

    ctx.transport.stats = { ...base, limitation: 'cpu' };
    ctx.scheduler.advance(1_000);
    await settle(4);

    ctx.transport.stats = { ...base, limitation: 'none' };
    for (let i = 0; i < 6; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p1080p60');
  });

  it('a escada de CPU nunca chega a 30fps', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN, { presetId: 'p720p60eco' });
    ctx.transport.stats = {
      fps: 20,
      bitrateBps: 2_000_000,
      rttMs: 30,
      limitation: 'cpu',
      width: 1280,
      height: 720,
      availableBps: null,
    };

    for (let i = 0; i < 20; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(4);
    }

    // p720p30 tem a mesma resolução do eco: descer não aliviaria o encoder,
    // só cortaria framerate. A escada para aqui.
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p720p60eco');
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
    ...extra,
  });

  it('captura cai para 5fps quando ninguém está assistindo', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.setPeers([]);
    await settle();

    // Sem espectador não há encoder, mas a captura de tela continua — e a
    // 1080p60 ela custa GPU numa máquina que está rodando um jogo.
    expect(ctx.screen.video.constraints.at(-1)).toEqual({ frameRate: 5 });
  });

  it('captura volta ao framerate cheio quando alguém entra', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.setPeers([]);
    await settle();
    ctx.transport.setPeers([{ id: 'v_1', connectionState: 'connected', usingRelay: false }]);
    await settle();

    expect(ctx.screen.video.constraints.at(-1)).toEqual({ frameRate: 60 });
  });

  it('aplica teto de banda com folga, para não encher o cano', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    // O WebRTC estima 10 Mbps disponíveis.
    ctx.transport.stats = amostra({ availableBps: 10_000_000 });

    ctx.scheduler.advance(1_000);
    await settle();

    // 75% — os 25% de folga são a diferença entre transmitir e estrangular o
    // jogo, porque encher a fila do roteador é o que faz o ping subir.
    expect(ctx.transport.ceilings.at(-1)).toBe(7_500_000);
  });

  it('limitação por BANDA derruba o preset, não só por CPU', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.stats = amostra({ limitation: 'bandwidth' });

    for (let i = 0; i < 5; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle();
    }

    // Antes o código só olhava `cpu`: o WebRTC dizia "estou limitado pela
    // rede" e o produto seguia pedindo 8 Mbps de um link que não tinha.
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p720p60');
    expect(state.status === 'live' && state.presetForced).toBe(true);
  });

  it('alternar entre limitadores não acumula pressão indevida', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    for (let i = 0; i < 4; i += 1) {
      ctx.transport.stats = amostra({ limitation: i % 2 === 0 ? 'cpu' : 'bandwidth' });
      ctx.scheduler.advance(1_000);
      await settle();
    }

    // Nenhum dos dois chegou a cinco leituras seguidas.
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p1080p60');
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
