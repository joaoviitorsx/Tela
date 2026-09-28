import { afterEach, expect, it, vi } from 'vitest';
import { fakeConnectionFactory } from '../core/mesh/testing.js';
import { FakeScheduler, FakeSignalingChannel } from '../core/testing/fakes.js';
import { makeMeshTransport } from './mesh-transport.js';

class TestStream {
  private tracks: MediaStreamTrack[] = [];
  addTrack(track: MediaStreamTrack): void { this.tracks.push(track); }
  removeTrack(track: MediaStreamTrack): void { this.tracks = this.tracks.filter((item) => item !== track); }
  getTracks(): MediaStreamTrack[] { return [...this.tracks]; }
  getVideoTracks(): MediaStreamTrack[] { return this.tracks.filter((track) => track.kind === 'video'); }
  getAudioTracks(): MediaStreamTrack[] { return this.tracks.filter((track) => track.kind === 'audio'); }
}

class TestTrack {
  kind = 'video';
  muted = true;
  private listeners = new Map<string, Array<() => void>>();
  addEventListener(name: string, listener: () => void): void {
    const group = this.listeners.get(name) ?? [];
    group.push(listener);
    this.listeners.set(name, group);
  }
  emit(name: 'mute' | 'unmute'): void {
    this.muted = name === 'mute';
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

afterEach(() => vi.unstubAllGlobals());

it('a trilha desmutada devolve a UI a watching mesmo se ICE conectou antes', async () => {
  vi.stubGlobal('MediaStream', TestStream);
  const channel = new FakeSignalingChannel('v_1', 'viewer');
  const scheduler = new FakeScheduler();
  const factory = fakeConnectionFactory();
  const transport = makeMeshTransport({ channel, scheduler, createConnection: factory.create });
  let reconnecting = 0;
  let reconnected = 0;
  transport.on('reconnecting', () => { reconnecting += 1; });
  transport.on('reconnected', () => { reconnected += 1; });
  await transport.watch('joao', { invite: 'c'.repeat(22) });
  const pc = factory.created[0];
  if (pc === undefined) throw new Error('PC ausente');
  const track = new TestTrack();
  pc.ontrack?.({ track: track as unknown as MediaStreamTrack, streams: [] });
  track.emit('unmute');
  reconnected = 0;
  track.emit('mute');
  scheduler.advance(3_000);
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  expect(reconnecting).toBe(1);
  pc.emitState('connected');
  expect(reconnected).toBe(0);
  track.emit('unmute');
  expect(reconnected).toBe(1);
  await transport.disconnect();
});
