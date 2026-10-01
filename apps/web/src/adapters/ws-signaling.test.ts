import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@tela/shared';
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

async function hostAberto() {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const channel = makeWsSignaling('ws://test/signal');
  const opening = channel.host('joao', 'o'.repeat(43));
  const socket = FakeSocket.created[0];
  if (socket === undefined) throw new Error('socket ausente');
  socket.emit('open');
  socket.emit('message', JSON.stringify({
    type: 'hosting', peerId: 'h_1', iceServers: [], maxPeers: 3,
  }));
  await opening;
  return { channel, socket };
}

it('saudação leva a versão atual do protocolo, sem convite (ADR 0026)', async () => {
  const { channel, socket } = await hostAberto();
  const hello = JSON.parse(socket.sent[0]!);
  expect(hello).toMatchObject({ type: 'host', protocol: PROTOCOL_VERSION });
  expect(hello).not.toHaveProperty('invite');
  channel.close();
});

it('a reconexão do transmissor reapresenta a mesma saudação', async () => {
  vi.useFakeTimers();
  try {
    const { channel, socket } = await hostAberto();
    socket.close(); // queda: agenda reconexão
    // A primeira religação sai em 0,5–1 s (jitter); mais que isso deixaria o
    // relógio da saudação vencer e abrir um terceiro socket.
    await vi.advanceTimersByTimeAsync(1_000);
    const novo = FakeSocket.created[1];
    expect(novo).toBeDefined();
    novo?.emit('open');
    expect(JSON.parse(novo!.sent[0]!)).toMatchObject({ type: 'host', slug: 'joao', protocol: PROTOCOL_VERSION });
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
    const opening = channel.watch('joao', { nome: 'ana', chave: 'k'.repeat(22) });
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

it('espera de aprovação (ADR 0025): o relógio da saudação para e o watch só resolve no watching', async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const channel = makeWsSignaling('ws://test/signal');
    let esperando = 0;
    channel.on('aguardando-aprovacao', () => { esperando += 1; });
    let resolvido = false;
    const opening = channel.watch('joao', { nome: 'ana', chave: 'k'.repeat(22) })
      .then((v) => { resolvido = true; return v; });
    const socket = FakeSocket.created[0]!;
    socket.emit('open');
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: 'watch', name: 'ana', viewerKey: 'k'.repeat(22), protocol: PROTOCOL_VERSION,
    });
    socket.emit('message', JSON.stringify({ type: 'awaiting-approval' }));
    expect(esperando).toBe(1);
    // O transmissor pode demorar minutos: nada de HELLO_TIMEOUT.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(resolvido).toBe(false);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    socket.emit('message', JSON.stringify({
      type: 'watching', peerId: 'v_1', hostId: 'h_1', iceServers: [], viewers: 1,
    }));
    await expect(opening).resolves.toMatchObject({ selfId: 'v_1' });
    channel.close();
  } finally {
    vi.useRealTimers();
  }
});

it('DENIED durante a espera rejeita e não reconecta sozinho', async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const channel = makeWsSignaling('ws://test/signal');
    const opening = channel.watch('joao', { nome: 'ana', chave: 'k'.repeat(22) });
    const socket = FakeSocket.created[0]!;
    socket.emit('open');
    socket.emit('message', JSON.stringify({ type: 'awaiting-approval' }));
    socket.emit('message', JSON.stringify({ type: 'error', code: 'DENIED' }));
    await expect(opening).rejects.toEqual({ code: 'DENIED' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.created).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('transmissor recebe pedidos e responde com admit/deny', async () => {
  const { channel, socket } = await hostAberto();
  const pedidos: unknown[] = [];
  const cancelados: string[] = [];
  channel.on('pedido', (p) => pedidos.push(p));
  channel.on('pedido-cancelado', ({ peerId }) => cancelados.push(peerId));
  socket.emit('message', JSON.stringify({ type: 'join-request', peerId: 'v_2', name: 'ana', fingerprint: 'f'.repeat(64) }));
  socket.emit('message', JSON.stringify({ type: 'join-cancelled', peerId: 'v_3' }));
  expect(pedidos).toEqual([{ peerId: 'v_2', nome: 'ana', impressao: 'f'.repeat(64) }]);
  expect(cancelados).toEqual(['v_3']);
  channel.responderPedido('v_2', true);
  channel.responderPedido('v_4', false);
  expect(socket.sent.slice(-2).map((m) => JSON.parse(m))).toEqual([
    { type: 'admit', peerId: 'v_2' },
    { type: 'deny', peerId: 'v_4' },
  ]);
  channel.close();
});

it('sala aberta: sem apelido nem chave, o hello não manda campos vazios (ADR 0028)', async () => {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const channel = makeWsSignaling('ws://test/signal');
  void channel.watch('joao', { nome: '', chave: '' }).catch(() => undefined);
  const socket = FakeSocket.created[0]!;
  socket.emit('open');
  const hello = JSON.parse(socket.sent[0]!);
  expect(hello).not.toHaveProperty('name');
  expect(hello).not.toHaveProperty('viewerKey');
  channel.close();
});

it('a saudação de transmissor leva a capacidade declarada, e a reconexão a repete', async () => {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const channel = makeWsSignaling('ws://test/signal');
  const opening = channel.host('joao', 'o'.repeat(43), { capacidade: 50 });
  const socket = FakeSocket.created[0];
  if (socket === undefined) throw new Error('socket ausente');
  socket.emit('open');
  const hello = JSON.parse(socket.sent[0] ?? '{}') as { type: string; capacidade?: number };
  expect(hello).toMatchObject({ type: 'host', capacidade: 50 });
  socket.emit('message', JSON.stringify({ type: 'hosting', peerId: 'h_1', iceServers: [], maxPeers: 50 }));
  await opening;
  channel.close();
});

it('sem capacidade declarada a saudação não inventa uma', async () => {
  const { socket, channel } = await hostAberto();
  const hello = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
  expect('capacidade' in hello).toBe(false);
  channel.close();
});

it('CHANNEL_FULL traz o teto da sala que recusou, quando o servidor diz', async () => {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const channel = makeWsSignaling('ws://test/signal');
  const opening = channel.watch('joao', { nome: 'ana', chave: 'k'.repeat(32) });
  const socket = FakeSocket.created[0];
  if (socket === undefined) throw new Error('socket ausente');
  socket.emit('open');
  socket.emit('message', JSON.stringify({ type: 'error', code: 'CHANNEL_FULL', maxPeers: 5 }));
  await expect(opening).rejects.toMatchObject({ code: 'CHANNEL_FULL', maxPeers: 5 });
  channel.close();
});
