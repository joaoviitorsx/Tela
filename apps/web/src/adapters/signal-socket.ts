import {
  type ClientMessage,
  type ServerMessage,
  ServerMessageSchema,
  SIGNAL_PING_INTERVAL_MS,
} from '@tela/shared';

/**
 * WebSocket de sinalização com o mínimo em volta: validação de schema na
 * entrada e keepalive na saída.
 *
 * Fica em `adapters/` porque `WebSocket` é API de browser — `core/` não sabe
 * que isto existe.
 */
export type SignalSocket = {
  send(message: ClientMessage): void;
  close(): void;
};

export type SignalHandlers = {
  onMessage(message: ServerMessage): void;
  onClose(): void;
};

export function openSignalSocket(
  url: string,
  ticket: string,
  handlers: SignalHandlers,
): Promise<SignalSocket> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('signal socket failed'));
      return;
    }

    let settled = false;
    let keepalive: ReturnType<typeof setInterval> | null = null;

    const api: SignalSocket = {
      send(message) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
      close() {
        if (keepalive !== null) clearInterval(keepalive);
        socket.close();
      },
    };

    socket.addEventListener('open', () => {
      // O ticket vai na primeira MENSAGEM, não na URL: query string de
      // WebSocket aparece no access log do proxy.
      api.send({ t: 'hello', ticket });
      keepalive = setInterval(() => api.send({ t: 'ping' }), SIGNAL_PING_INTERVAL_MS);
    });

    socket.addEventListener('message', (event) => {
      let json: unknown;
      try {
        json = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      const parsed = ServerMessageSchema.safeParse(json);
      if (!parsed.success) return;

      const message = parsed.data;
      if (!settled) {
        // `ready` é o aperto de mão: só depois dele a conexão vale.
        if (message.t === 'ready') {
          settled = true;
          resolve(api);
        } else if (message.t === 'error') {
          settled = true;
          api.close();
          reject(new Error(message.code));
          return;
        }
      }
      handlers.onMessage(message);
    });

    socket.addEventListener('close', () => {
      if (keepalive !== null) clearInterval(keepalive);
      if (!settled) {
        settled = true;
        reject(new Error('SIGNAL_CLOSED'));
      }
      handlers.onClose();
    });

    socket.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        reject(new Error('SIGNAL_ERROR'));
      }
    });
  });
}
