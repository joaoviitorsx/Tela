import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@tela/shared';
import type { RoomEvent } from '../../application/handle-room-event.js';
import { type Socket, makeSignalingHub } from './hub.js';
import { issueTicket } from './ticket.js';

const SECRET = 's'.repeat(40);
const NOW = 1_700_000_000_000;

class SpySocket implements Socket {
  readonly sent: ServerMessage[] = [];
  closed = false;
  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
  last(): ServerMessage | undefined {
    return this.sent.at(-1);
  }
  ofType<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

function ticketFor(role: 'publisher' | 'viewer', identity: string, room = 'b_joao') {
  return issueTicket(SECRET, { room, identity, role, exp: Math.floor(NOW / 1000) + 900 });
}

describe('hub de sinalização', () => {
  let events: RoomEvent[];
  let hub: ReturnType<typeof makeSignalingHub>;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    hub = makeSignalingHub({
      secret: SECRET,
      maxViewers: 3,
      now: () => NOW,
      onRoomEvent: (e) => events.push(e),
    });
  });

  function connect(role: 'publisher' | 'viewer', id: string) {
    const socket = new SpySocket();
    const conn = hub.accept(socket);
    conn.receive(JSON.stringify({ t: 'hello', ticket: ticketFor(role, id) }));
    return { socket, conn };
  }

  it('transmissor entra e recebe ready sem peers', () => {
    const { socket } = connect('publisher', 'p_1');
    expect(socket.last()).toEqual({
      t: 'ready',
      role: 'publisher',
      room: 'b_joao',
      self: 'p_1',
      peers: [],
    });
  });

  it('recusa ticket inválido e fecha o socket', () => {
    const socket = new SpySocket();
    hub.accept(socket).receive(JSON.stringify({ t: 'hello', ticket: 'lixo' }));
    expect(socket.last()).toEqual({ t: 'error', code: 'BAD_TICKET' });
    expect(socket.closed).toBe(true);
  });

  it('recusa espectador quando não há transmissor', () => {
    const { socket } = connect('viewer', 'v_1');
    expect(socket.last()).toEqual({ t: 'error', code: 'NO_PUBLISHER' });
  });

  it('avisa o transmissor quando um espectador chega', () => {
    const pub = connect('publisher', 'p_1');
    connect('viewer', 'v_1');
    expect(pub.socket.ofType('peer-joined')).toEqual([{ t: 'peer-joined', peer: 'v_1' }]);
    expect(events).toContainEqual({
      kind: 'participant_joined',
      room: 'b_joao',
      identity: 'v_1',
      isPublisher: false,
    });
  });

  it('espectador vê o transmissor na lista de peers', () => {
    connect('publisher', 'p_1');
    const viewer = connect('viewer', 'v_1');
    expect(viewer.socket.last()).toMatchObject({ t: 'ready', role: 'viewer', peers: ['p_1'] });
  });

  it('roteia SDP do transmissor para o espectador endereçado', () => {
    const pub = connect('publisher', 'p_1');
    const v1 = connect('viewer', 'v_1');
    const v2 = connect('viewer', 'v_2');

    pub.conn.receive(
      JSON.stringify({ t: 'describe', to: 'v_2', sdp: { type: 'offer', sdp: 'v=0 para v2' } }),
    );

    expect(v2.socket.ofType('describe')).toEqual([
      { t: 'describe', from: 'p_1', sdp: { type: 'offer', sdp: 'v=0 para v2' } },
    ]);
    expect(v1.socket.ofType('describe')).toEqual([]);
  });

  it('espectador não precisa endereçar — vai sempre para o transmissor', () => {
    const pub = connect('publisher', 'p_1');
    const v1 = connect('viewer', 'v_1');

    v1.conn.receive(JSON.stringify({ t: 'describe', sdp: { type: 'answer', sdp: 'v=0 resposta' } }));

    expect(pub.socket.ofType('describe')).toEqual([
      { t: 'describe', from: 'v_1', sdp: { type: 'answer', sdp: 'v=0 resposta' } },
    ]);
  });

  it('espectador não consegue falar com outro espectador', () => {
    connect('publisher', 'p_1');
    const v1 = connect('viewer', 'v_1');
    const v2 = connect('viewer', 'v_2');

    v1.conn.receive(
      JSON.stringify({ t: 'describe', to: 'v_2', sdp: { type: 'offer', sdp: 'malicioso' } }),
    );

    expect(v2.socket.ofType('describe')).toEqual([]);
  });

  it('roteia candidatos ICE', () => {
    const pub = connect('publisher', 'p_1');
    const v1 = connect('viewer', 'v_1');
    v1.conn.receive(
      JSON.stringify({ t: 'ice', candidate: { candidate: 'candidate:1 1 udp', sdpMid: '0' } }),
    );
    expect(pub.socket.ofType('ice')).toHaveLength(1);
  });

  it('aplica o teto de espectadores', () => {
    connect('publisher', 'p_1');
    connect('viewer', 'v_1');
    connect('viewer', 'v_2');
    connect('viewer', 'v_3');
    const excedente = connect('viewer', 'v_4');
    expect(excedente.socket.last()).toEqual({ t: 'error', code: 'VIEWER_LIMIT' });
    expect(hub.countViewers('b_joao')).toBe(3);
  });

  it('recusa um segundo transmissor na mesma sala', () => {
    connect('publisher', 'p_1');
    const outro = connect('publisher', 'p_2');
    expect(outro.socket.last()).toEqual({ t: 'error', code: 'PUBLISHER_TAKEN' });
  });

  it('reconexão do mesmo transmissor derruba o socket antigo', () => {
    const primeiro = connect('publisher', 'p_1');
    const segundo = connect('publisher', 'p_1');
    expect(primeiro.socket.closed).toBe(true);
    expect(segundo.socket.last()).toMatchObject({ t: 'ready', role: 'publisher' });
  });

  it('saída do transmissor derruba todos os espectadores', () => {
    const pub = connect('publisher', 'p_1');
    const v1 = connect('viewer', 'v_1');
    pub.conn.disconnect();
    expect(v1.socket.closed).toBe(true);
    expect(events).toContainEqual({ kind: 'room_finished', room: 'b_joao' });
    expect(hub.roomCount).toBe(0);
  });

  it('saída de espectador avisa o transmissor e libera a vaga', () => {
    const pub = connect('publisher', 'p_1');
    const v1 = connect('viewer', 'v_1');
    v1.conn.disconnect();
    expect(pub.socket.ofType('peer-left')).toEqual([{ t: 'peer-left', peer: 'v_1' }]);
    expect(hub.countViewers('b_joao')).toBe(0);
  });

  it('mensagem antes do hello é recusada', () => {
    const socket = new SpySocket();
    hub.accept(socket).receive(JSON.stringify({ t: 'ping' }));
    expect(socket.last()).toEqual({ t: 'error', code: 'BAD_TICKET' });
  });

  it('JSON inválido e schema inválido são recusados', () => {
    const a = new SpySocket();
    hub.accept(a).receive('{{{');
    expect(a.last()).toEqual({ t: 'error', code: 'BAD_MESSAGE' });

    const b = new SpySocket();
    hub.accept(b).receive(JSON.stringify({ t: 'desconhecido' }));
    expect(b.last()).toEqual({ t: 'error', code: 'BAD_MESSAGE' });
  });

  it('socket que não manda hello a tempo é fechado', () => {
    const socket = new SpySocket();
    hub.accept(socket);
    vi.advanceTimersByTime(5_001);
    expect(socket.last()).toEqual({ t: 'error', code: 'HELLO_TIMEOUT' });
    expect(socket.closed).toBe(true);
  });

  it('ping responde pong', () => {
    const pub = connect('publisher', 'p_1');
    pub.conn.receive(JSON.stringify({ t: 'ping' }));
    expect(pub.socket.last()).toEqual({ t: 'pong' });
  });

  it('closeRoom derruba todo mundo', () => {
    const pub = connect('publisher', 'p_1');
    const v1 = connect('viewer', 'v_1');
    hub.closeRoom('b_joao');
    expect(pub.socket.closed).toBe(true);
    expect(v1.socket.closed).toBe(true);
    expect(hub.roomCount).toBe(0);
  });
});
