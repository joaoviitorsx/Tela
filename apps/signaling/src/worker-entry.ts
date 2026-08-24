import { SLUG_RE } from '@tela/shared';
import { ChannelRoom, type Env, type HibernatableSocket, type WebCryptoLike, makeChannelDeps } from './worker.js';

/**
 * Ponto de entrada do Cloudflare Worker.
 *
 * Fica separado de `worker.ts` de propósito: aqui moram os globais da
 * plataforma (`WebSocketPair`, `Response` com `webSocket`), e lá mora a lógica
 * — que é testável sem runtime nenhum, e é testada, na suíte de conformidade.
 *
 * Este arquivo é a única parte do servidor que não tem teste automatizado.
 * É proposital: ele não decide nada. Se crescer além de "abrir o par de
 * sockets e delegar", algo foi parar no lugar errado.
 */

/* Globais do runtime da Cloudflare, declarados no mínimo necessário. */
declare const WebSocketPair: {
  new (): { 0: HibernatableSocket; 1: HibernatableSocket & { accept(): void } };
};
declare const crypto: WebCryptoLike;

/**
 * O que o runtime entrega, declarado à mão para não depender dos tipos do
 * `workers-types` só por causa de três membros.
 */
type DurableState = {
  acceptWebSocket(socket: HibernatableSocket): void;
  getWebSockets(): HibernatableSocket[];
  /** Exclusão mútua real: os input gates só cobrem `await` de storage. */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
};

const SLUG_HEADER = 'x-tela-slug';

export class ChannelDurableObject {
  private readonly room: ChannelRoom;
  private slug = '';

  constructor(state: DurableState, env: Env) {
    this.room = new ChannelRoom(state, makeChannelDeps(env, crypto));
  }

  async fetch(request: Request): Promise<Response> {
    this.slug = request.headers.get(SLUG_HEADER) ?? '';

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // `acceptWebSocket`, e NÃO `server.accept()`: só o primeiro permite que o
    // objeto hiberne com a conexão aberta. Trocar um pelo outro é a diferença
    // entre caber no free tier e não caber.
    this.room.accept(server);

    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(socket: HibernatableSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    await this.room.handleMessage(socket, this.slug, text);
  }

  async webSocketClose(socket: HibernatableSocket): Promise<void> {
    this.room.handleClose(socket);
  }

  async webSocketError(socket: HibernatableSocket): Promise<void> {
    this.room.handleClose(socket);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      /**
       * `channels: null` de propósito, e não omitido.
       *
       * Com um Durable Object por slug não existe um lugar que enxergue todos
       * os canais — a contagem que o servidor Node dá simplesmente não tem
       * equivalente aqui. Dizer `null` é honesto; omitir o campo faria a
       * resposta parecer a mesma coisa com um dado faltando.
       */
      return new Response(JSON.stringify({ ok: true, runtime: 'durable-object', channels: null }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/signal' || url.pathname.startsWith('/signal/')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('esperado WebSocket', { status: 426 });
      }

      // O slug decide QUAL Durable Object atende, então todos os peers de um
      // canal caem na mesma instância sem roteamento nosso.
      const slug = url.pathname.replace(/^\/signal\/?/, '').toLowerCase();
      if (!SLUG_RE.test(slug)) return new Response('slug inválido', { status: 400 });

      const id = env.CHANNELS.idFromName(slug);
      const headers = new Headers(request.headers);
      headers.set(SLUG_HEADER, slug);

      return await env.CHANNELS.get(id).fetch(new Request(request.url, { headers }));
    }

    /**
     * Todo o resto é o front estático, servido pelo MESMO Worker.
     *
     * Uma origem só: o WebSocket vira `wss://<host>/signal/<slug>` sem CORS,
     * sem variável de build e sem uma segunda publicação para esquecer de
     * fazer. E requisição de asset estático não conta na cota de Workers.
     */
    if (env.ASSETS !== undefined) return await env.ASSETS.fetch(request);
    return new Response('front não publicado neste Worker', { status: 404 });
  },
};
