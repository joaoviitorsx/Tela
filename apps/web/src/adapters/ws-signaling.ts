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
export function makeWsSignaling(baseUrl: string): SignalingChannel {
  const emitter = new Emitter<ChannelEvents>();

  let socket: WebSocket | null = null;
  let opened = false;
  let closedByUs = false;

  /**
   * O slug vai NA URL, além de ir na primeira mensagem.
   *
   * Não é redundância: em Durable Objects o caminho é o que decide qual
   * instância atende (`idFromName`), então sem ele todos os canais cairiam no
   * mesmo objeto. O servidor portátil ignora o caminho, e o Worker valida que
   * os dois batem — cliente que diverge é confuso ou malicioso.
   */
  const endpoint = (slug: string) => `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(slug)}`;

  function attach(
    resolve: (value: ChannelOpened) => void,
    reject: (error: SignalingError) => void,
    hello: ClientMessage,
    slug: string,
  ): void {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint(slug));
    } catch {
      // Navegador que recusa abrir o socket (política, esquema bloqueado):
      // não conseguimos falar com o servidor, e isso não é "sem transmissão".
      reject({ code: 'SIGNAL_UNREACHABLE' });
      return;
    }
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

    /**
     * Socket que fecha ou falha ANTES da resposta do servidor não diz nada
     * sobre haver transmissão — diz que não conseguimos falar com o servidor.
     *
     * Reportar `NOT_HOSTING` aqui foi um erro caro: um usuário no Brave via
     * "ninguém está transmitindo, aguardando" e ficava esperando por uma
     * transmissão que estava no ar. Todo bloqueio de navegador, proxy
     * corporativo ou queda de rede virava a mesma mensagem errada.
     */
    ws.addEventListener('close', () => {
      window.clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject({ code: 'SIGNAL_UNREACHABLE' });
        return;
      }
      if (opened && !closedByUs) emitter.emit('closed', { reason: 'SIGNAL_CLOSED' });
    });

    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject({ code: 'SIGNAL_UNREACHABLE' });
    });
  }

  return {
    host(slug, ownerToken) {
      return new Promise<ChannelOpened>((resolve, reject) => {
        attach(resolve, reject, { type: 'host', slug, ownerToken }, slug);
      });
    },

    watch(slug) {
      return new Promise<ChannelOpened>((resolve, reject) => {
        attach(resolve, reject, { type: 'watch', slug }, slug);
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
