import { beforeEach, describe, expect, it } from 'vitest';
import { CONTENT_HINT } from '@tela/shared';
import {
  FakeApi,
  FakeAudioCapture,
  FakePublisherTransport,
  FakeScheduler,
  FakeScreenCapture,
  FakeViewerTransport,
  P2P_CONNECTION,
  fakeTransports,
} from '../testing/fakes.js';
import { BroadcastSession } from './broadcast-session.js';

const SLUG = 'joao';
const TOKEN = 'o'.repeat(43);

function build() {
  const api = new FakeApi();
  const screen = new FakeScreenCapture();
  const audio = new FakeAudioCapture();
  const publisher = new FakePublisherTransport();
  const viewer = new FakeViewerTransport();
  const scheduler = new FakeScheduler();

  const session = new BroadcastSession({
    api,
    transports: fakeTransports(publisher, viewer),
    screen,
    audio,
    scheduler,
    statsIntervalMs: 1_000,
  });

  const seen: string[] = [];
  session.subscribe(() => seen.push(session.getState().status));

  return { api, screen, audio, publisher, scheduler, session, seen };
}

describe('BroadcastSession — caminho feliz', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('percorre idle → requesting-capture → connecting → live', async () => {
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.seen).toEqual(['requesting-capture', 'connecting', 'connecting', 'live']);
    expect(ctx.session.getState().status).toBe('live');
  });

  it('marca contentHint=motion na trilha de vídeo', async () => {
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.screen.video.contentHint).toBe(CONTENT_HINT);
  });

  it('publica com exatamente duas camadas de simulcast', async () => {
    await ctx.session.start(SLUG, TOKEN);
    const request = ctx.publisher.published.at(-1);
    expect(request?.layers).toHaveLength(2);
  });

  it('pede captura na resolução e no framerate do preset', async () => {
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.screen.lastRequest).toMatchObject({ width: 1920, height: 1080, frameRate: 60 });
  });

  it('expõe shareUrl e emite started para a UI copiar o link', async () => {
    const links: string[] = [];
    ctx.session.on('started', ({ shareUrl }) => links.push(shareUrl));
    await ctx.session.start(SLUG, TOKEN);
    expect(links).toEqual([`https://tela.gg/${SLUG}`]);
  });

  it('propaga o transporte escolhido pelo servidor', async () => {
    ctx.api.connection = P2P_CONNECTION;
    await ctx.session.start(SLUG, TOKEN);
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.transport).toBe('p2p');
  });
});

describe('BroadcastSession — falhas', () => {
  it('captura negada termina em ended:CAPTURE_DENIED sem chamar a API', async () => {
    const ctx = build();
    ctx.screen.denied = true;
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'CAPTURE_DENIED' });
    expect(ctx.publisher.connected).toBeNull();
  });

  it('browser sem getDisplayMedia termina em CAPTURE_UNSUPPORTED', async () => {
    const ctx = build();
    ctx.screen.supported = false;
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'CAPTURE_UNSUPPORTED' });
  });

  it('token inválido termina em OWNER_INVALID e solta a captura', async () => {
    const ctx = build();
    ctx.api.startError = 'OWNER_INVALID';
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'OWNER_INVALID' });
    expect((ctx.screen.video as unknown as { stopped: boolean }).stopped).toBe(true);
  });

  it('falha de transporte termina em TRANSPORT_FAILED', async () => {
    const ctx = build();
    ctx.publisher.failOnConnect = true;
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'TRANSPORT_FAILED' });
  });

  it('usuário parando pelo controle nativo do browser encerra a sessão', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    (ctx.screen.video as unknown as { fireEnded(): void }).fireEnded();
    await Promise.resolve();
    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'CAPTURE_ENDED' });
  });

  it('start duplicado é ignorado enquanto já está ao vivo', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.publisher.published).toHaveLength(1);
  });
});

describe('BroadcastSession — heartbeat e espectadores', () => {
  it('faz ping a cada 10s e atualiza a contagem', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.api.viewers = 4;

    ctx.scheduler.advance(10_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.api.pings).toBe(1);
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.viewers).toBe(4);
  });

  it('NOT_LIVE no ping encerra em vez de mentir AO VIVO', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.api.pingError = 'NOT_LIVE';

    ctx.scheduler.advance(10_000);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(ctx.session.getState().status).toBe('ended');
  });

  it('evento de espectadores do transporte atualiza sem esperar o ping', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.publisher.emit('viewers', 2);
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.viewers).toBe(2);
  });

  it('reconectando e reconectado voltam ao ar', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    ctx.publisher.emit('reconnecting', undefined);
    expect(ctx.session.getState().status).toBe('reconnecting');

    ctx.publisher.emit('reconnected', undefined);
    expect(ctx.session.getState().status).toBe('live');
  });
});

describe('BroadcastSession — qualidade', () => {
  it('respeita o preset escolhido no start', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN, { presetId: 'p720p60' });
    expect(ctx.publisher.published[0]?.maxBitrate).toBe(4_000_000);
  });

  it('troca de preset ao vivo republica sem derrubar a sessão', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPreset('p720p60eco');

    expect(ctx.publisher.published).toHaveLength(2);
    expect(ctx.publisher.published[1]?.maxBitrate).toBe(2_500_000);
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p720p60eco');
  });

  it('trocar para o mesmo preset não republica', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.setPreset('p1080p60');
    expect(ctx.publisher.published).toHaveLength(1);
  });

  it('pressão de CPU sustentada derruba um degrau e marca como forçado', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.publisher.stats = {
      fps: 42,
      bitrateBps: 5_000_000,
      rttMs: 30,
      limitation: 'cpu',
      width: 1920,
      height: 1080,
    };

    for (let i = 0; i < 5; i += 1) {
      ctx.scheduler.advance(1_000);
      for (let j = 0; j < 4; j += 1) await Promise.resolve();
    }

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p720p60');
    expect(state.status === 'live' && state.presetForced).toBe(true);
  });

  it('uma leitura isolada com cpu NÃO derruba o preset', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);

    const cpu = { fps: 55, bitrateBps: 7_000_000, rttMs: 30, width: 1920, height: 1080 };
    ctx.publisher.stats = { ...cpu, limitation: 'cpu' };
    ctx.scheduler.advance(1_000);
    for (let j = 0; j < 4; j += 1) await Promise.resolve();

    ctx.publisher.stats = { ...cpu, limitation: 'none' };
    for (let i = 0; i < 6; i += 1) {
      ctx.scheduler.advance(1_000);
      for (let j = 0; j < 4; j += 1) await Promise.resolve();
    }

    const state = ctx.session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p1080p60');
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
  it('stop solta trilhas, fecha transporte, cancela timers e avisa o servidor', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.stop();

    expect(ctx.session.getState()).toEqual({ status: 'ended', reason: 'USER_STOPPED' });
    expect((ctx.screen.video as unknown as { stopped: boolean }).stopped).toBe(true);
    expect(ctx.publisher.closed).toBe(true);
    expect(ctx.scheduler.pending).toBe(0);
    expect(ctx.api.beacons).toEqual([{ slug: SLUG, ownerToken: TOKEN }]);
  });

  it('stop repetido não duplica o beacon', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.stop();
    await ctx.session.stop();
    expect(ctx.api.beacons).toHaveLength(1);
  });

  it('não faz mais ping depois de parar', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    await ctx.session.stop();
    ctx.scheduler.advance(60_000);
    expect(ctx.api.pings).toBe(0);
  });

  it('queda definitiva do transporte encerra a sessão', async () => {
    const ctx = build();
    await ctx.session.start(SLUG, TOKEN);
    ctx.publisher.emit('closed', { reason: 'signal' });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(ctx.session.getState().status).toBe('ended');
  });
});

describe('BroadcastSession — áudio', () => {
  it('usa o áudio do getDisplayMedia quando existe (Windows)', async () => {
    const ctx = build();
    ctx.screen.withAudio = true;
    await ctx.session.start(SLUG, TOKEN);
    expect(ctx.publisher.published[0]?.audio).not.toBeNull();
    const state = ctx.session.getState();
    expect(state.status === 'live' && state.hasAudio).toBe(true);
  });

  it('cai para o sink virtual quando o browser não entrega áudio (Linux)', async () => {
    const ctx = build();
    ctx.screen.withAudio = false;
    await ctx.session.start(SLUG, TOKEN, { audioDeviceId: 'monitor-1' });
    expect(ctx.publisher.published[0]?.audio).not.toBeNull();
  });

  it('falha ao capturar áudio transmite mudo em vez de abortar', async () => {
    const ctx = build();
    ctx.audio.fails = true;
    await ctx.session.start(SLUG, TOKEN, { audioDeviceId: 'monitor-1' });
    expect(ctx.session.getState().status).toBe('live');
    expect(ctx.publisher.published[0]?.audio).toBeNull();
  });
});
