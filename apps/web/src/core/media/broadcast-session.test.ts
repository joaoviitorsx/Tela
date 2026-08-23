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
    const base = { fps: 55, bitrateBps: 7_000_000, rttMs: 30, width: 1920, height: 1080 };

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

  it('queda do canal encerra a sessão', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.transport.emit('closed', { reason: 'SIGNAL_CLOSED' });
    await settle();
    expect(ctx.session.getState().status).toBe('ended');
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
