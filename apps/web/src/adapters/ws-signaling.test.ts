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
  const opening = channel.host('joao', 'o'.repeat(43), 'c'.repeat(22));
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

async function hostAberto() {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const channel = makeWsSignaling('ws://test/signal');
  const opening = channel.host('joao', 'o'.repeat(43), 'c'.repeat(22));
  const socket = FakeSocket.created[0];
  if (socket === undefined) throw new Error('socket ausente');
  socket.emit('open');
  socket.emit('message', JSON.stringify({
    type: 'hosting', peerId: 'h_1', iceServers: [], maxPeers: 3,
  }));
  await opening;
  return { channel, socket };
}

it('saudação v2 leva protocolo e convite (TELA-018)', async () => {
  const { channel, socket } = await hostAberto();
  expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'host', protocol: 2, invite: 'c'.repeat(22) });
  channel.close();
});

it('setInvite resolve na confirmação e a reconexão passa a levar o convite novo', async () => {
  vi.useFakeTimers();
  try {
    const { channel, socket } = await hostAberto();
    const pedido = channel.setInvite('d'.repeat(22));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'set-invite', invite: 'd'.repeat(22) });
    socket.emit('message', JSON.stringify({ type: 'invite-set' }));
    await expect(pedido).resolves.toBeUndefined();

    socket.close(); // queda: agenda reconexão
    // A primeira religação sai em 0,5–1 s (jitter); mais que isso deixaria o
    // relógio da saudação vencer e abrir um terceiro socket.
    await vi.advanceTimersByTimeAsync(1_000);
    const novo = FakeSocket.created[1];
    expect(novo).toBeDefined();
    novo?.emit('open');
    expect(JSON.parse(novo!.sent[0]!)).toMatchObject({ type: 'host', invite: 'd'.repeat(22) });
    channel.close();
  } finally {
    vi.useRealTimers();
  }
});

it('REMOVED depois de aberto não reconecta sozinho', async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const channel = makeWsSignaling('ws://test/signal');
    const motivos: string[] = [];
    channel.on('closed', ({ reason }) => motivos.push(reason));
    const opening = channel.watch('joao', { invite: 'c'.repeat(22) });
    const socket = FakeSocket.created[0]!;
    socket.emit('open');
    socket.emit('message', JSON.stringify({
      type: 'watching', peerId: 'v_1', hostId: 'h_1', iceServers: [], viewers: 1,
    }));
    await opening;
    socket.emit('message', JSON.stringify({ type: 'error', code: 'REMOVED' }));
    socket.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(motivos).toEqual(['REMOVED']);
    expect(FakeSocket.created).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
