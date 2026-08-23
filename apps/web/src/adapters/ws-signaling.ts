import {
  type ClientMessage,
  HELLO_TIMEOUT_MS,
  type ServerMessage,
  ServerMessageSchema,
} from '@tela/shared';
import { Emitter } from '../core/emitter.js';
import type {
  ChannelEvents,
  ChannelOpened,
  SignalingChannel,
  SignalingError,
} from '../core/ports/signaling-channel.js';

/**
 * `SignalingChannel` sobre WebSocket.
 *
 * Único arquivo do front que sabe que WebSocket existe. O núcleo fala com a
 * porta; trocar por um broker gerenciado é reescrever só este arquivo.
 */
export function makeWsSignaling(url: string): SignalingChannel {
  const emitter = new Emitter<ChannelEvents>();

  let socket: WebSocket | null = null;
  let opened = false;
  let closedByUs = false;

  function attach(
    resolve: (value: ChannelOpened) => void,
    reject: (error: SignalingError) => void,
    hello: ClientMessage,
  ): void {
    let settled = false;
    const ws = new WebSocket(url);
    socket = ws;

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      // Servidor aceitou o socket e nunca respondeu. Sem este relógio a
      // promessa não resolve nem rejeita, e a UI fica presa em "conectando".
      ws.close();
      reject({ code: 'HELLO_TIMEOUT' });
    }, HELLO_TIMEOUT_MS * 2);

    ws.addEventListener('open', () => ws.send(JSON.stringify(hello)));

    ws.addEventListener('message', (event) => {
      let json: unknown;
      try {
        json = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      const parsed = ServerMessageSchema.safeParse(json);
      if (!parsed.success) return;
      const message: ServerMessage = parsed.data;

      if (!settled) {
        if (message.type === 'hosting') {
          settled = true;
          opened = true;
          window.clearTimeout(timer);
          resolve({
            role: 'host',
            selfId: message.peerId,
            hostId: null,
            iceServers: message.iceServers,
            maxPeers: message.maxPeers,
          });
          return;
        }
        if (message.type === 'watching') {
          settled = true;
          opened = true;
          window.clearTimeout(timer);
          resolve({
            role: 'viewer',
            selfId: message.peerId,
            hostId: message.hostId,
            iceServers: message.iceServers,
            maxPeers: 0,
          });
          return;
        }
        if (message.type === 'error') {
          settled = true;
          window.clearTimeout(timer);
          ws.close();
          reject({ code: message.code });
          return;
        }
      }

      switch (message.type) {
        case 'peer-joined':
          return emitter.emit('peer-joined', { peerId: message.peerId });
        case 'peer-left':
          return emitter.emit('peer-left', { peerId: message.peerId });
        case 'signal':
          return emitter.emit('signal', { from: message.from, payload: message.payload });
        case 'error':
          return emitter.emit('closed', { reason: message.code });
        default:
          return;
      }
    });

    ws.addEventListener('close', () => {
      window.clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject({ code: 'NOT_HOSTING' });
        return;
      }
      if (opened && !closedByUs) emitter.emit('closed', { reason: 'SIGNAL_CLOSED' });
    });

    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject({ code: 'NOT_HOSTING' });
    });
  }

  return {
    host(slug, ownerToken) {
      return new Promise<ChannelOpened>((resolve, reject) => {
        attach(resolve, reject, { type: 'host', slug, ownerToken });
      });
    },

    watch(slug) {
      return new Promise<ChannelOpened>((resolve, reject) => {
        attach(resolve, reject, { type: 'watch', slug });
      });
    },

    send(payload, to) {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      const message: ClientMessage =
        to === undefined
          ? { type: 'signal', payload }
          : { type: 'signal', to, payload };
      socket.send(JSON.stringify(message));
    },

    on(event, handler) {
      return emitter.on(event, handler);
    },

    close() {
      closedByUs = true;
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'leave' } satisfies ClientMessage));
      }
      socket?.close();
      socket = null;
      emitter.clear();
    },
  };
}
