import {
  type ClientMessage,
  ClientMessageSchema,
  type ServerMessage,
  HELLO_TIMEOUT_MS,
} from '@tela/shared';
import type { RoomEvent } from '../../application/handle-room-event.js';
import { verifyTicket } from './ticket.js';

/**
 * Hub de sinalização P2P.
 *
 * Roteia SDP e ICE entre o transmissor e cada espectador. NÃO vê mídia — o
 * tráfego aqui é de kilobytes por sessão, contra gigabytes por hora no SFU.
 * É este o componente que torna o self-host doméstico viável: ele cabe num
 * Raspberry Pi e não consome banda de saída.
 *
 * Topologia: estrela, transmissor no centro. Espectador só conversa com o
 * transmissor. Não há malha entre espectadores nem relay em cascata — ver
 * docs/adr/0002 para por que a árvore de relay foi rejeitada.
 *
 * Deliberadamente ignorante de WebSocket: recebe `Socket`, uma interface de
 * duas funções. Isso é o que permite testar o roteamento inteiro sem rede.
 */
export type Socket = {
  send(message: ServerMessage): void;
  close(): void;
};

export type SignalErrorCode = Extract<ServerMessage, { t: 'error' }>['code'];

type Peer = {
  readonly id: string;
  readonly role: 'publisher' | 'viewer';
  readonly socket: Socket;
};

type Room = {
  publisher: Peer | null;
  readonly viewers: Map<string, Peer>;
};

export type HubDeps = {
  secret: string;
  maxViewers: number;
  now: () => number;
  /** Alimenta o mesmo caso de uso que o webhook do LiveKit alimenta. */
  onRoomEvent: (event: RoomEvent) => void;
};

export type Connection = {
  /** Chame com o texto cru recebido do socket. */
  receive(raw: string): void;
  /** Chame quando o socket fechar, por qualquer motivo. */
  disconnect(): void;
};

export function makeSignalingHub(deps: HubDeps) {
  const rooms = new Map<string, Room>();

  const roomOf = (name: string): Room => {
    const existing = rooms.get(name);
    if (existing) return existing;
    const created: Room = { publisher: null, viewers: new Map() };
    rooms.set(name, created);
    return created;
  };

  const dropIfEmpty = (name: string) => {
    if (name === '') return;
    const room = rooms.get(name);
    if (room && room.publisher === null && room.viewers.size === 0) rooms.delete(name);
  };

  function peerIn(room: Room, id: string): Peer | null {
    if (room.publisher?.id === id) return room.publisher;
    return room.viewers.get(id) ?? null;
  }

  return {
    /** Fecha a sala inteira — usado por `closeRoom` do BroadcastGateway. */
    closeRoom(name: string): void {
      const room = rooms.get(name);
      if (!room) return;
      for (const viewer of room.viewers.values()) viewer.socket.close();
      room.publisher?.socket.close();
      rooms.delete(name);
    },

    countViewers(name: string): number {
      return rooms.get(name)?.viewers.size ?? 0;
    },

    hasPublisher(name: string): boolean {
      return rooms.get(name)?.publisher !== null && rooms.get(name)?.publisher !== undefined;
    },

    get roomCount(): number {
      return rooms.size;
    },

    /**
     * Registra um socket recém-aberto. Ele ainda não pertence a nenhuma sala:
     * só entra depois de um `hello` com ticket válido.
     */
    accept(socket: Socket): Connection {
      let peer: Peer | null = null;
      let roomName: string | null = null;
      let closed = false;
      /** Sala que o hello tentou entrar, mesmo quando a entrada foi recusada. */
      let lastRoom = '';

      const helloTimer = setTimeout(() => {
        if (peer === null && !closed) {
          socket.send({ t: 'error', code: 'HELLO_TIMEOUT' });
          socket.close();
        }
      }, HELLO_TIMEOUT_MS);
      // Não segura o processo vivo por causa de um socket ocioso.
      helloTimer.unref?.();

      function fail(code: SignalErrorCode): void {
        // Sem este clearTimeout, toda conexão recusada segurava um timer até
        // HELLO_TIMEOUT_MS e disparava um segundo frame de erro num socket
        // que já estava fechado.
        clearTimeout(helloTimer);
        socket.send({ t: 'error', code });
        socket.close();
        // `roomOf` registra a sala antes da validação, e um hello recusado
        // sai sem `peer` — então o `disconnect` retorna cedo e nunca chama
        // `dropIfEmpty`. `NO_PUBLISHER` é o caminho NORMAL de um espectador
        // que chega na janela entre o /broadcast/start e o hello do
        // transmissor, então isso vazava uma sala por tentativa, para sempre.
        if (peer === null && roomName === null) dropIfEmpty(lastRoom);
      }

      function handleHello(ticket: string): void {
        const claims = verifyTicket(deps.secret, ticket, Math.floor(deps.now() / 1000));
        if (claims === null) return fail('BAD_TICKET');

        lastRoom = claims.room;
        const room = roomOf(claims.room);

        if (claims.role === 'publisher') {
          if (room.publisher !== null && room.publisher.id !== claims.identity) {
            // Um transmissor por sala. R6: múltiplos transmissores está fora
            // de escopo, e permitir aqui abriria o buraco pela porta dos fundos.
            return fail('PUBLISHER_TAKEN');
          }
          // Reconexão do mesmo transmissor: derruba o socket velho.
          room.publisher?.socket.close();
          peer = { id: claims.identity, role: 'publisher', socket };
          room.publisher = peer;
        } else {
          if (room.publisher === null) return fail('NO_PUBLISHER');
          const previous = room.viewers.get(claims.identity);
          if (previous === undefined && room.viewers.size >= deps.maxViewers) {
            return fail('VIEWER_LIMIT');
          }
          // Ticket é bearer e vale 15 minutos: a mesma identidade pode aparecer
          // duas vezes. Sem fechar o socket anterior, ele continuava roteando
          // SDP assinado como o mesmo peer, atropelando a negociação do socket
          // legítimo — e a saída de um derrubava a PeerConnection do outro.
          previous?.socket.close();
          peer = { id: claims.identity, role: 'viewer', socket };
          room.viewers.set(peer.id, peer);
        }

        roomName = claims.room;
        clearTimeout(helloTimer);

        socket.send({
          t: 'ready',
          role: claims.role,
          room: claims.room,
          self: claims.identity,
          peers:
            claims.role === 'publisher'
              ? [...room.viewers.keys()]
              : room.publisher
                ? [room.publisher.id]
                : [],
        });

        if (claims.role === 'viewer' && room.publisher) {
          // O transmissor é quem faz a oferta — ele tem a mídia.
          room.publisher.socket.send({ t: 'peer-joined', peer: claims.identity });
          deps.onRoomEvent({
            kind: 'participant_joined',
            room: claims.room,
            identity: claims.identity,
            isPublisher: false,
          });
        }
      }

      /** Espectador só fala com o transmissor; transmissor endereça por `to`. */
      function resolveTarget(room: Room, to: string | undefined, self: Peer): Peer | null {
        if (self.role === 'viewer') return room.publisher;
        return to ? (room.viewers.get(to) ?? null) : null;
      }

      function handleRouted(message: Extract<ClientMessage, { t: 'describe' | 'ice' }>): void {
        if (peer === null || roomName === null) return fail('BAD_TICKET');
        const room = rooms.get(roomName);
        if (!room) return;
        // Mesma checagem de identidade do `disconnect`: um socket desalojado
        // por outra conexão com a mesma identidade não pode continuar falando
        // em nome dela.
        if (peerIn(room, peer.id) !== peer) return;
        const target = resolveTarget(room, message.to, peer);
        if (target === null) return;
        if (message.t === 'describe') {
          target.socket.send({ t: 'describe', from: peer.id, sdp: message.sdp });
        } else {
          target.socket.send({ t: 'ice', from: peer.id, candidate: message.candidate });
        }
      }

      return {
        receive(raw: string): void {
          if (closed) return;
          let json: unknown;
          try {
            json = JSON.parse(raw);
          } catch {
            return fail('BAD_MESSAGE');
          }
          const parsed = ClientMessageSchema.safeParse(json);
          if (!parsed.success) return fail('BAD_MESSAGE');

          const message = parsed.data;
          if (message.t === 'hello') {
            if (peer !== null) return; // hello duplicado: ignora
            return handleHello(message.ticket);
          }
          if (peer === null) return fail('BAD_TICKET'); // qualquer coisa antes do hello
          if (message.t === 'ping') return socket.send({ t: 'pong' });
          if (message.t === 'bye') return socket.close();
          return handleRouted(message);
        },

        disconnect(): void {
          if (closed) return;
          closed = true;
          clearTimeout(helloTimer);
          if (peer === null || roomName === null) return;

          const room = rooms.get(roomName);
          if (!room) return;
          const self = peerIn(room, peer.id);
          if (self !== peer) return; // já foi substituído por uma reconexão

          if (peer.role === 'publisher') {
            room.publisher = null;
            for (const viewer of room.viewers.values()) viewer.socket.close();
            room.viewers.clear();
            deps.onRoomEvent({ kind: 'room_finished', room: roomName });
          } else {
            room.viewers.delete(peer.id);
            room.publisher?.socket.send({ t: 'peer-left', peer: peer.id });
            deps.onRoomEvent({
              kind: 'participant_left',
              room: roomName,
              identity: peer.id,
              isPublisher: false,
            });
          }
          dropIfEmpty(roomName);
        },
      };
    },
  };
}

export type SignalingHub = ReturnType<typeof makeSignalingHub>;
