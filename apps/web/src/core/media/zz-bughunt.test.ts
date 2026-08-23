import { describe, expect, it } from 'vitest';
import type { Connection } from '@tela/shared';
import { Emitter } from '../emitter.js';
import type {
  PublishRequest,
  PublisherEvents,
  PublisherTransport,
  TransportStats,
  ViewerEvents,
  ViewerTransport,
} from '../ports/media-transport.js';
import {
  FakeApi,
  FakeAudioCapture,
  FakePublisherTransport,
  FakeScheduler,
  FakeScreenCapture,
  FakeViewerTransport,
  SFU_CONNECTION,
  fakeTransports,
} from '../testing/fakes.js';
import { BroadcastSession } from './broadcast-session.js';
import { ViewerSession } from './viewer-session.js';

const SLUG = 'joao';
const TOKEN = 'o'.repeat(43);
const settle = async (times = 12) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

/* ─────────────────── 1. stop() concorrente com start() ─────────────────── */

class SlowApi extends FakeApi {
  release!: () => void;
  private readonly gate = new Promise<void>((r) => {
    this.release = r;
  });
  override async startBroadcast(slug: string) {
    await this.gate;
    return super.startBroadcast(slug);
  }
}

describe('BUGHUNT BroadcastSession', () => {
  it('S1: stop() durante o connecting não pode ser desfeito pelo start() em voo', async () => {
    const api = new SlowApi();
    const publisher = new FakePublisherTransport();
    const screen = new FakeScreenCapture();
    const scheduler = new FakeScheduler();
    const session = new BroadcastSession({
      api,
      transports: fakeTransports(publisher, new FakeViewerTransport()),
      screen,
      audio: new FakeAudioCapture(),
      scheduler,
      statsIntervalMs: 1_000,
    });

    const started = session.start(SLUG, TOKEN);
    await settle();
    expect(session.getState().status).toBe('connecting');

    // Usuário desiste enquanto a API ainda não respondeu.
    await session.stop();
    expect(session.getState()).toEqual({ status: 'ended', reason: 'USER_STOPPED' });
    expect(api.beacons).toHaveLength(1);
    expect((screen.video as unknown as { stopped: boolean }).stopped).toBe(true);

    api.release();
    await started;
    await settle();

    // O start() em voo não deve ressuscitar a sessão.
    expect(session.getState()).toEqual({ status: 'ended', reason: 'USER_STOPPED' });
    expect(publisher.connected).toBeNull();
    expect(publisher.published).toHaveLength(0);
    expect(scheduler.pending).toBe(0);
  });

  it('S2: track de vídeo é null quando o start em voo publica após o stop', async () => {
    const api = new SlowApi();
    const publisher = new FakePublisherTransport();
    const session = new BroadcastSession({
      api,
      transports: fakeTransports(publisher, new FakeViewerTransport()),
      screen: new FakeScreenCapture(),
      audio: new FakeAudioCapture(),
      scheduler: new FakeScheduler(),
    });

    const started = session.start(SLUG, TOKEN);
    await settle();
    await session.stop();
    api.release();
    await started;
    await settle();

    expect(publisher.published.map((r: PublishRequest) => r.video)).toEqual([]);
  });

  it('S3: heartbeat depois do stop-durante-start não fica pingando sem credencial', async () => {
    const api = new SlowApi();
    const scheduler = new FakeScheduler();
    const session = new BroadcastSession({
      api,
      transports: fakeTransports(new FakePublisherTransport(), new FakeViewerTransport()),
      screen: new FakeScreenCapture(),
      audio: new FakeAudioCapture(),
      scheduler,
    });

    const started = session.start(SLUG, TOKEN);
    await settle();
    await session.stop();
    api.release();
    await started;
    await settle();

    scheduler.advance(60_000);
    await settle();
    expect(scheduler.pending).toBe(0);
  });
});

/* ──────── 2. ViewerSession: falha que rejeita E emite 'closed' ──────── */

/** Reproduz o transporte P2P real: o socket cai durante o connect. */
class ClosingViewerTransport implements ViewerTransport {
  private readonly emitter = new Emitter<ViewerEvents>();
  connects = 0;
  closed = 0;
  async connect(): Promise<void> {
    this.connects += 1;
    // openSignalSocket rejeita E o handler onClose emite 'closed'. Ambos.
    this.emitter.emit('closed', { reason: 'SIGNAL_CLOSED' });
    throw new Error('SIGNAL_CLOSED');
  }
  async readStats(): Promise<TransportStats | null> {
    return null;
  }
  on<K extends keyof ViewerEvents>(event: K, handler: (p: ViewerEvents[K]) => void) {
    return this.emitter.on(event, handler);
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

describe('BUGHUNT ViewerSession', () => {
  it('V1: connect que rejeita e emite closed agenda UMA tentativa, não duas', async () => {
    const api = new FakeApi();
    const scheduler = new FakeScheduler();
    const transport = new ClosingViewerTransport();
    const session = new ViewerSession({
      api,
      transports: {
        publisher: async () => new FakePublisherTransport(),
        viewer: async () => transport,
      },
      scheduler,
    });

    await session.open(SLUG);
    await settle(20);

    expect(scheduler.pending).toBe(1);
  });

  it('V2: a cada rodada o número de tentativas concorrentes não pode dobrar', async () => {
    const api = new FakeApi();
    const scheduler = new FakeScheduler();
    const transport = new ClosingViewerTransport();
    const session = new ViewerSession({
      api,
      transports: {
        publisher: async () => new FakePublisherTransport(),
        viewer: async () => transport,
      },
      scheduler,
    });

    await session.open(SLUG);
    await settle(20);

    const connectsPorRodada: number[] = [transport.connects];
    for (let i = 0; i < 5; i += 1) {
      const antes = transport.connects;
      scheduler.advance(60_000);
      await settle(40);
      connectsPorRodada.push(transport.connects - antes);
    }
    expect(connectsPorRodada).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('V3: cancels não cresce sem limite enquanto a transmissão está offline', async () => {
    const api = new FakeApi();
    api.live = false;
    const scheduler = new FakeScheduler();
    const session = new ViewerSession({
      api,
      transports: fakeTransports(new FakePublisherTransport(), new FakeViewerTransport()),
      scheduler,
    });

    await session.open(SLUG);
    for (let i = 0; i < 30; i += 1) {
      scheduler.advance(30_000);
      await settle();
    }
    const inner = session as unknown as { cancels: unknown[] };
    expect(inner.cancels.length).toBeLessThan(3);
  });

  it('V4: FULL nunca mais sai do estado failed mesmo quando a sala esvazia', async () => {
    const api = new FakeApi();
    api.joinError = 'VIEWER_LIMIT';
    const scheduler = new FakeScheduler();
    const session = new ViewerSession({
      api,
      transports: fakeTransports(new FakePublisherTransport(), new FakeViewerTransport()),
      scheduler,
    });

    await session.open(SLUG);
    expect(session.getState().status).toBe('failed');

    // A transmissão termina: deveria virar offline, não continuar "sala cheia".
    api.live = false;
    scheduler.advance(30_000);
    await settle();
    expect(session.getState().status).toBe('offline');
  });

  it('V5: open() duas vezes não pode deixar o transporte anterior aberto', async () => {
    const api = new FakeApi();
    const first = new FakeViewerTransport();
    const second = new FakeViewerTransport();
    const pool = [first, second];
    const scheduler = new FakeScheduler();
    const session = new ViewerSession({
      api,
      transports: {
        publisher: async () => new FakePublisherTransport(),
        viewer: async () => pool.shift() ?? second,
      },
      scheduler,
    });

    await session.open(SLUG);
    await session.open('outro');
    await settle();

    expect(first.closed).toBe(true);
  });

  it('V6: backoff respeita o teto de 30s', async () => {
    const api = new FakeApi();
    api.live = false;
    const scheduler = new FakeScheduler();
    const session = new ViewerSession({
      api,
      transports: fakeTransports(new FakePublisherTransport(), new FakeViewerTransport()),
      scheduler,
    });
    await session.open(SLUG);
    const vistos: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const s = session.getState();
      if (s.status === 'offline') vistos.push(s.nextPollMs);
      scheduler.advance(30_000);
      await settle();
    }
    expect(Math.max(...vistos)).toBeLessThanOrEqual(30_000);
  });
});

/* ─────────── 3. Emitter/estado auxiliar usado pelas sessões ─────────── */

describe('BUGHUNT misc', () => {
  it('M1: setPreset com sessão parada não deixa presetForced pendurado', async () => {
    const api = new FakeApi();
    const publisher = new FakePublisherTransport();
    const session = new BroadcastSession({
      api,
      transports: fakeTransports(publisher, new FakeViewerTransport()),
      screen: new FakeScreenCapture(),
      audio: new FakeAudioCapture(),
      scheduler: new FakeScheduler(),
      statsIntervalMs: 1_000,
    });

    await session.start(SLUG, TOKEN);
    publisher.stats = {
      fps: 40,
      bitrateBps: 1,
      rttMs: 1,
      limitation: 'cpu',
      width: 1,
      height: 1,
    };
    const scheduler = (session as unknown as { deps: { scheduler: FakeScheduler } }).deps.scheduler;
    for (let i = 0; i < 5; i += 1) {
      scheduler.advance(1_000);
      await settle();
    }
    let state = session.getState();
    expect(state.status === 'live' && state.presetForced).toBe(true);

    await session.stop();
    await session.start(SLUG, TOKEN);
    state = session.getState();
    expect(state.status === 'live' && state.presetId).toBe('p1080p60');
    expect(state.status === 'live' && state.presetForced).toBe(false);
  });

  it('M2: reconnected devolve a contagem de espectadores em vez de zerar', async () => {
    const api = new FakeApi();
    const publisher = new FakePublisherTransport();
    const session = new BroadcastSession({
      api,
      transports: fakeTransports(publisher, new FakeViewerTransport()),
      screen: new FakeScreenCapture(),
      audio: new FakeAudioCapture(),
      scheduler: new FakeScheduler(),
    });
    await session.start(SLUG, TOKEN);
    publisher.emit('viewers', 3);
    publisher.emit('reconnecting', undefined);
    publisher.emit('reconnected', undefined);
    const state = session.getState();
    expect(state.status === 'live' && state.viewers).toBe(3);
  });

  it('M3: closed durante reconnecting encerra a sessão', async () => {
    const api = new FakeApi();
    const publisher = new FakePublisherTransport();
    const session = new BroadcastSession({
      api,
      transports: fakeTransports(publisher, new FakeViewerTransport()),
      screen: new FakeScreenCapture(),
      audio: new FakeAudioCapture(),
      scheduler: new FakeScheduler(),
    });
    await session.start(SLUG, TOKEN);
    publisher.emit('reconnecting', undefined);
    publisher.emit('closed', { reason: 'x' });
    await settle();
    expect(session.getState().status).toBe('ended');
  });
});

void SFU_CONNECTION;
void ({} as Connection);
void ({} as PublisherEvents);
void ({} as PublisherTransport);
