import { describe, expect, it } from 'vitest';
import {
  ClosingViewerTransport,
  FakeApi,
  GatedViewerTransport,
  FakePublisherTransport,
  FakeScheduler,
  FakeViewerTransport,
  fakeTransports,
} from '../testing/fakes.js';
import { ViewerSession } from './viewer-session.js';

const SLUG = 'joao';

function build() {
  const api = new FakeApi();
  const viewer = new FakeViewerTransport();
  const scheduler = new FakeScheduler();
  const session = new ViewerSession({
    api,
    transports: fakeTransports(new FakePublisherTransport(), viewer),
    scheduler,
    statsIntervalMs: 1_000,
  });
  return { api, viewer, scheduler, session };
}

const settle = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

describe('ViewerSession', () => {
  it('conecta quando a transmissão está no ar', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    expect(ctx.session.getState().status).toBe('watching');
    expect(ctx.viewer.connected).not.toBeNull();
  });

  it('offline não é erro — mostra estado e agenda nova tentativa', async () => {
    const ctx = build();
    ctx.api.live = false;
    await ctx.session.open(SLUG);

    const state = ctx.session.getState();
    expect(state.status).toBe('offline');
    expect(state.status === 'offline' && state.nextPollMs).toBe(5_000);
    expect(ctx.scheduler.pending).toBe(1);
  });

  it('conecta sozinho quando a transmissão sobe — o amigo só deixou a aba aberta', async () => {
    const ctx = build();
    ctx.api.live = false;
    await ctx.session.open(SLUG);

    ctx.api.live = true;
    ctx.scheduler.advance(5_000);
    await settle();

    expect(ctx.session.getState().status).toBe('watching');
  });

  it('faz backoff de 5s até 30s enquanto continua offline', async () => {
    const ctx = build();
    ctx.api.live = false;
    await ctx.session.open(SLUG);

    const observados: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const state = ctx.session.getState();
      if (state.status === 'offline') observados.push(state.nextPollMs);
      ctx.scheduler.advance(state.status === 'offline' ? state.nextPollMs : 5_000);
      await settle();
    }

    expect(observados[0]).toBe(5_000);
    expect(observados.at(-1)).toBe(30_000);
    expect(Math.max(...observados)).toBeLessThanOrEqual(30_000);
  });

  it('sala cheia vira estado próprio e continua tentando', async () => {
    const ctx = build();
    ctx.api.joinError = 'VIEWER_LIMIT';
    await ctx.session.open(SLUG);

    const state = ctx.session.getState();
    expect(state.status).toBe('failed');
    expect(state.status === 'failed' && state.reason).toBe('FULL');
    expect(ctx.scheduler.pending).toBeGreaterThan(0);
  });

  it('queda do transmissor volta para offline e reconecta depois', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.viewer.emit('closed', { reason: 'PUBLISHER_LEFT' });
    await settle();

    expect(ctx.session.getState().status).toBe('offline');

    ctx.scheduler.advance(5_000);
    await settle();
    expect(ctx.session.getState().status).toBe('watching');
  });

  it('reconnecting do transporte não derruba a sessão', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.viewer.emit('reconnecting', undefined);
    expect(ctx.session.getState().status).toBe('reconnecting');
  });

  it('amostra estatísticas enquanto assiste', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.viewer.stats = {
      fps: 60,
      bitrateBps: 7_400_000,
      rttMs: 142,
      limitation: 'none',
      width: 1920,
      height: 1080,
    };

    ctx.scheduler.advance(1_000);
    await settle();

    const state = ctx.session.getState();
    expect(state.status === 'watching' && state.stats?.rttMs).toBe(142);
  });

  it('close cancela tudo e não reconecta mais', async () => {
    const ctx = build();
    ctx.api.live = false;
    await ctx.session.open(SLUG);
    await ctx.session.close();

    ctx.api.live = true;
    ctx.scheduler.advance(60_000);
    await settle();

    expect(ctx.session.getState().status).not.toBe('watching');
    expect(ctx.viewer.connected).toBeNull();
  });

  it('falha de conexão do transporte não trava — volta a tentar', async () => {
    const ctx = build();
    ctx.viewer.failOnConnect = true;
    await ctx.session.open(SLUG);
    expect(ctx.session.getState().status).toBe('offline');
    expect(ctx.scheduler.pending).toBeGreaterThan(0);
  });
});

/**
 * Regressões da reconexão.
 *
 * O modo de falha real do WebSocket de sinalização notifica DUAS vezes: a
 * promessa do `connect` rejeita e o handler de fechamento emite `closed`.
 * Cada notificação agendava uma tentativa, e cada tentativa dobrava a
 * próxima rodada — 1, 2, 4, 8, 16, 32 conexões concorrentes saindo de uma
 * aba que o usuário deixou aberta. Autoataque, não bug cosmético.
 */
describe('ViewerSession — reconexão não pode multiplicar', () => {
  function buildClosing() {
    const api = new FakeApi();
    const transport = new ClosingViewerTransport();
    const scheduler = new FakeScheduler();
    const session = new ViewerSession({
      api,
      transports: {
        publisher: async () => new FakePublisherTransport(),
        viewer: async () => transport,
      },
      scheduler,
    });
    return { api, transport, scheduler, session };
  }

  it('falha dupla (reject + closed) agenda UMA tentativa', async () => {
    const ctx = buildClosing();
    await ctx.session.open(SLUG);
    await settle(20);
    expect(ctx.scheduler.pending).toBe(1);
  });

  it('cada rodada faz exatamente uma tentativa, sem dobrar', async () => {
    const ctx = buildClosing();
    await ctx.session.open(SLUG);
    await settle(20);

    const porRodada: number[] = [ctx.transport.connects];
    for (let i = 0; i < 5; i += 1) {
      const antes = ctx.transport.connects;
      ctx.scheduler.advance(60_000);
      await settle(40);
      porRodada.push(ctx.transport.connects - antes);
    }
    expect(porRodada).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('30 rodadas offline não acumulam timers pendentes', async () => {
    const ctx = build();
    ctx.api.live = false;
    await ctx.session.open(SLUG);

    for (let i = 0; i < 30; i += 1) {
      ctx.scheduler.advance(30_000);
      await settle();
    }
    // Uma única vaga de retry, sempre. Antes, crescia uma por rodada.
    expect(ctx.scheduler.pending).toBe(1);
  });

  it('sala cheia volta para offline quando a transmissão acaba', async () => {
    const ctx = build();
    ctx.api.joinError = 'VIEWER_LIMIT';
    await ctx.session.open(SLUG);
    expect(ctx.session.getState().status).toBe('failed');

    ctx.api.live = false;
    ctx.scheduler.advance(30_000);
    await settle();

    // Continuar dizendo "lotada" depois que ninguém está transmitindo é mentira.
    expect(ctx.session.getState().status).toBe('offline');
  });

  it('close() durante o connect não publica watching depois', async () => {
    const api = new FakeApi();
    const transport = new GatedViewerTransport();
    const scheduler = new FakeScheduler();
    const session = new ViewerSession({
      api,
      transports: {
        publisher: async () => new FakePublisherTransport(),
        viewer: async () => transport,
      },
      scheduler,
    });

    void session.open(SLUG);
    await settle();
    expect(session.getState().status).toBe('connecting');

    // Usuário fecha a aba enquanto o primeiro frame ainda não chegou.
    await session.close();
    transport.deliver();
    await settle(30);

    expect(session.getState().status).not.toBe('watching');
    expect(scheduler.pending).toBe(0);
  });

  it('abrir outro slug fecha o transporte anterior', async () => {
    const api = new FakeApi();
    const first = new FakeViewerTransport();
    const second = new FakeViewerTransport();
    const pool = [first, second];
    const session = new ViewerSession({
      api,
      transports: {
        publisher: async () => new FakePublisherTransport(),
        viewer: async () => pool.shift() ?? second,
      },
      scheduler: new FakeScheduler(),
    });

    await session.open(SLUG);
    await session.open('outro');
    await settle();

    expect(first.closed).toBe(true);
  });
});
