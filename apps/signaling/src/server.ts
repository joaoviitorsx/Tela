import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { SLUG_RE, isBlockedSlug } from '@tela/shared';
import { MAX_FRAME_BYTES, SIGNAL_PING_INTERVAL_MS } from '@tela/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { makeChannelRegistry } from './channel-registry.js';
import { RateBuckets } from './limits.js';
import { origemPermitida } from './origem.js';
import { loadConfig } from './config.js';
import { ipDoCliente } from './ip-do-cliente.js';
import { makeIceProvider, makePeerIdGenerator } from './ice.js';
import { describeIceSettings } from './ice-settings.js';

const config = loadConfig();

const registry = makeChannelRegistry({
  limits: config.limits,
  now: () => Date.now(),
  hash: (input) => createHash('sha256').update(input, 'utf8').digest('hex'),
  equals: (a, b) => {
    if (a.length !== b.length) return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  },
  isValidSlug: (slug) => SLUG_RE.test(slug) && !isBlockedSlug(slug),
  iceServersFor: makeIceProvider(config),
  newPeerId: makePeerIdGenerator(),
  setTimer: (ms, task) => {
    const id = setTimeout(task, ms);
    id.unref?.();
    return () => clearTimeout(id);
  },
});

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runtime: 'node', channels: registry.channelCount, iceConfig: describeIceSettings(config.ice) }));
    return;
  }
  res.writeHead(404).end();
});

/** S-17: o cabeçalho só vale se `TRUST_PROXY` disser; ver `ip-do-cliente.ts`. */
function ipDe(req: IncomingMessage): string {
  return ipDoCliente(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.trustProxy);
}

const aberturas = new RateBuckets(() => Date.now());

const wss = new WebSocketServer({
  server: http,
  maxPayload: MAX_FRAME_BYTES,
  /**
   * Antes do upgrade, e nada depois dele: recusar aqui não aloca registro,
   * timer nem socket (TELA-019). `ALLOWED_ORIGINS` era lido do ambiente e
   * nunca aplicado — a regra existia só no config.
   */
  verifyClient: (info, done) => {
    if (!origemPermitida(info.origin, config.allowedOrigins)) {
      done(false, 403, 'origem não permitida');
      return;
    }
    const ip = ipDe(info.req);
    if (!aberturas.take(`open:${ip}`, config.limits.openLimit, config.limits.openWindowMs)) {
      done(false, 429, 'muitas conexões');
      return;
    }
    done(true);
  },
});

wss.on('connection', (socket: WebSocket, req) => {
  const remote = ipDe(req);

  const connection = registry.accept(
    {
      send(message) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
      close() {
        try {
          socket.close();
        } catch {
          /* socket já morto */
        }
      },
    },
    remote,
  );

  socket.on('message', (raw: Buffer | string) => {
    connection.receive(typeof raw === 'string' ? raw : raw.toString('utf8'));
  });
  socket.on('close', () => connection.disconnect());
  socket.on('error', () => connection.disconnect());
});

/**
 * Keepalive e detecção de socket morto.
 *
 * O ping parte daqui porque JavaScript de browser não consegue enviar frame de
 * ping — o browser responde pong sozinho. Quem não responde entre dois ciclos
 * está morto: proxies e roteadores domésticos deixam conexões meio-abertas
 * que nunca disparam `close`, e uma dessas segura a vaga do canal para sempre.
 */
const alive = new WeakSet<WebSocket>();
wss.on('connection', (socket) => {
  alive.add(socket);
  socket.on('pong', () => alive.add(socket));
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!alive.has(socket)) {
      socket.terminate();
      continue;
    }
    alive.delete(socket);
    socket.ping();
  }
  registry.sweep();
}, SIGNAL_PING_INTERVAL_MS);

/**
 * Desligamento que realmente desliga.
 *
 * `wss.close()` para de aceitar conexões novas mas NÃO encerra as abertas, e
 * `http.close()` só chama o callback quando a última terminar. Com um único
 * WebSocket vivo o processo nunca saía: em systemd ou Docker isso vira
 * timeout de shutdown em todo deploy, e o "encerramento gracioso" acaba
 * entregando RST aos clientes em vez de um close limpo.
 */
const shutdown = () => {
  clearInterval(heartbeat);
  for (const socket of wss.clients) {
    try {
      socket.close(1001, 'servidor encerrando');
    } catch {
      socket.terminate();
    }
  }
  wss.close();
  http.close(() => process.exit(0));

  /**
   * `wss.clients` NÃO contém conexão que nunca fez upgrade.
   *
   * Um keep-alive HTTP ocioso — o `/health` de um proxy ou balanceador, ou
   * seja, produção — não aparece ali, e o `http.close()` espera por ele até o
   * estouro de 3s. Medido: uma única conexão TCP ociosa transformava um
   * desligamento de 10ms em 3009ms, em TODO deploy.
   *
   * Os 150ms de espera existem para o frame de close 1001 dos WebSockets sair
   * antes: destruir o socket na mesma volta do event loop pode cortar o frame
   * e entregar RST no lugar do encerramento limpo que acabamos de pedir.
   */
  const soltarOciosas = setTimeout(() => http.closeIdleConnections?.(), 150);
  soltarOciosas.unref?.();

  // Cliente que ignora o close educado não pode segurar o desligamento.
  const forcar = setTimeout(() => {
    for (const socket of wss.clients) socket.terminate();
    http.closeAllConnections?.();
    process.exit(0);
  }, 3_000);
  forcar.unref?.();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

http.listen(config.PORT, config.HOST, () => {
  console.warn(
    `[signaling] no ar em ${config.HOST}:${config.PORT} · maxPeers=${config.limits.maxPeers}`,
  );
});
