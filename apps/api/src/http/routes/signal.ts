import { SIGNAL_PING_INTERVAL_MS, type ServerMessage } from '@tela/shared';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../composition.js';

/**
 * WebSocket de sinalização do modo P2P.
 *
 * Esta rota é a única coisa que o servidor precisa fazer para uma transmissão
 * P2P acontecer. Ela não vê um byte de mídia — o vídeo vai direto do browser
 * do transmissor para o browser de cada espectador. É por isso que o modo P2P
 * roda no PC do próprio usuário: aqui não há egress para pagar nem CPU de
 * encaminhamento para gastar.
 *
 * O ticket vai na PRIMEIRA MENSAGEM, não na URL — query string de WebSocket
 * aparece no access log do Caddy.
 */
export async function signalRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  if (!deps.hub) return;
  const hub = deps.hub;

  app.get('/signal', { websocket: true }, (socket) => {
    const connection = hub.accept({
      send(message: ServerMessage) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
      close() {
        try {
          socket.close();
        } catch {
          /* socket já morto */
        }
      },
    });

    // Proxies e roteadores domésticos matam WebSocket ocioso. O ping do
    // protocolo WS (não o do nosso protocolo) resolve sem tráfego de aplicação.
    const keepalive = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, SIGNAL_PING_INTERVAL_MS);

    socket.on('message', (raw: Buffer | string) => {
      // Teto de 64KB por frame: SDP grande é legítimo, megabyte não é.
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (text.length > 64 * 1024) return socket.close();
      connection.receive(text);
    });

    socket.on('close', () => {
      clearInterval(keepalive);
      connection.disconnect();
    });

    socket.on('error', () => {
      clearInterval(keepalive);
      connection.disconnect();
    });
  });
}
