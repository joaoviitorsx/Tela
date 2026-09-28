import { afterEach, expect, it, vi } from 'vitest';
import { makeWsSignaling } from './ws-signaling.js';

class FakeSocket {
  static readonly OPEN = 1;
  static created: FakeSocket[] = [];
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: string | undefined }) => void>>();

  constructor(readonly url: string) { FakeSocket.created.push(this); }
  addEventListener(type: string, listener: (event: { data?: string | undefined }) => void): void {
    const group = this.listeners.get(type) ?? [];
    group.push(listener);
    this.listeners.set(type, group);
  }
  send(value: string): void { this.sent.push(value); }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeSocket.created = [];
});

it('renova ICE no mesmo socket com resposta correlacionada e chamada coalescida', async () => {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const channel = makeWsSignaling('ws://test/signal');
  const opening = channel.host('joao', 'o'.repeat(43));
  const socket = FakeSocket.created[0];
  if (socket === undefined) throw new Error('socket ausente');
  socket.emit('open');
  socket.emit('message', JSON.stringify({
    type: 'hosting', peerId: 'h_1', iceServers: [{ urls: 'stun:test' }], maxPeers: 3,
    issuedAt: 0, expiresAt: 600_000,
  }));
  await opening;

  const first = channel.refreshIce();
  const second = channel.refreshIce();
  expect(second).toBe(first);
  const requests = socket.sent.map((raw) => JSON.parse(raw) as { type: string; requestId?: string });
  const request = requests.find((item) => item.type === 'refresh-ice');
  expect(request?.requestId).toBeTruthy();
  socket.emit('message', JSON.stringify({
    type: 'ice-servers', requestId: 'wrong', iceServers: [], relayStatus: 'unavailable',
  }));
  socket.emit('message', JSON.stringify({
    type: 'ice-servers', requestId: request?.requestId,
    iceServers: [{ urls: 'turn:relay.test', username: 'new', credential: 'secret' }],
    relayStatus: 'available', issuedAt: 100, expiresAt: 600_100,
  }));
  expect((await first).iceServers[0]?.username).toBe('new');
  channel.close();
});
