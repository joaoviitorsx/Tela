import { MAX_FRAME_BYTES, SLUG_RE } from '@tela/shared';
import {
  ChannelRoom, IpLimiter, type Env, type HibernatableSocket, type WebCryptoLike,
  aberturaPermitida, makeChannelDeps, makeIpGate,
} from './worker.js';
import { describeIceSettings, parseIceSettings } from './ice-settings.js';
import { DEFAULT_LIMITS } from './limits.js';
import { listaDeOrigens, origemPermitida } from './origem.js';
import { ROTA_ESTADO, comMemoria, consultarPeloObjeto, type ConsultarEstado } from './estado-do-canal.js';
import { type Reescritor, servirComPrevia } from './previa.js';
import { atenderInteracao, type SubtleEd25519 } from './discord.js';
import { lerConfigDoDiscord } from './discord-config.js';

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
declare const crypto: WebCryptoLike & { subtle: SubtleEd25519 };
declare const HTMLRewriter: { new (): Reescritor };

/**
 * A consulta de estado com memória vive no escopo do módulo, que é o escopo
 * do isolate: é o que faz a memória de 30 s valer entre requisições. Criada
 * na primeira, porque o namespace só chega com o `env`.
 */
let consultarEstado: ConsultarEstado | null = null;

function consultaDoIsolate(env: Env): ConsultarEstado {
  consultarEstado ??= comMemoria(consultarPeloObjeto(env.CHANNELS));
  return consultarEstado;
}

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
    getAlarm(): Promise<number | null>;
    setAlarm(quando: number): Promise<void>;
  };
};

const SLUG_HEADER = 'x-tela-slug';
/**
 * IP do cliente, repassado ao objeto do canal. Quem escreve é só o Worker, a
 * partir de `CF-Connecting-IP` (que a Cloudflare define na borda e o cliente
 * não consegue forjar); um `x-tela-ip` mandado de fora é sobrescrito ou
 * apagado antes de chegar ao objeto.
 */
const IP_HEADER = 'x-tela-ip';

export class ChannelDurableObject {
  private readonly room: ChannelRoom;
  private slug = '';

  constructor(state: DurableState, env: Env) {
    this.room = new ChannelRoom(state, makeChannelDeps(env, crypto));
  }

  async fetch(request: Request): Promise<Response> {
    // Pergunta interna do Worker (prévia do link, `/tela` do Discord): só lê.
    // Não acorda socket, não grava nada. Ver `estado-do-canal.ts`.
    if (request.headers.get('Upgrade') !== 'websocket' && new URL(request.url).pathname === ROTA_ESTADO) {
      return new Response(JSON.stringify(this.room.estadoPublico()), {
        headers: { 'content-type': 'application/json' },
      });
    }

    this.slug = request.headers.get(SLUG_HEADER) ?? '';

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // `acceptWebSocket`, e NÃO `server.accept()`: só o primeiro permite que o
    // objeto hiberne com a conexão aberta. Trocar um pelo outro é a diferença
    // entre caber no free tier e não caber.
    this.room.accept(server, request.headers.get(IP_HEADER) ?? undefined);

    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  /** Único relógio que sobrevive à hibernação: expira quem não se apresentou. */
  async alarm(): Promise<void> {
    await this.room.expirarPendentes();
  }

  async webSocketMessage(socket: HibernatableSocket, message: string | ArrayBuffer): Promise<void> {
    // Binário grande sai antes de decodificar: o teto é em bytes.
    if (typeof message !== 'string' && message.byteLength > MAX_FRAME_BYTES) {
      socket.close(1009, 'BAD_MESSAGE');
      return;
    }
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

/**
 * Contador de abuso por IP (S-02): um objeto por IP, sem WebSocket. Toda a
 * lógica está em `IpLimiter` (testada); aqui só entra o HTTP.
 */
export class IpLimiterDurableObject {
  private readonly limiter: IpLimiter;

  constructor(state: DurableState) {
    this.limiter = new IpLimiter({ storage: state.storage });
  }

  async fetch(request: Request): Promise<Response> {
    const corpo = (await request.json()) as { chave?: unknown; limite?: unknown; janelaMs?: unknown };
    if (typeof corpo.chave !== 'string' || typeof corpo.limite !== 'number' || typeof corpo.janelaMs !== 'number') {
      return new Response('{"permitido":true}', { status: 400 });
    }
    const permitido = await this.limiter.take(corpo.chave, corpo.limite, corpo.janelaMs);
    return new Response(JSON.stringify({ permitido }), { headers: { 'content-type': 'application/json' } });
  }

  async alarm(): Promise<void> {
    await this.limiter.limpar();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      const parsedIce = parseIceSettings(env);
      const iceConfig = 'settings' in parsedIce
        ? { valid: true, ...describeIceSettings(parsedIce.settings) }
        : { valid: false, problems: parsedIce.problems };
      /**
       * `channels: null` de propósito, e não omitido.
       *
       * Com um Durable Object por slug não existe um lugar que enxergue todos
       * os canais — a contagem que o servidor Node dá simplesmente não tem
       * equivalente aqui. Dizer `null` é honesto; omitir o campo faria a
       * resposta parecer a mesma coisa com um dado faltando.
       */
      return new Response(JSON.stringify({ ok: true, runtime: 'durable-object', channels: null, iceConfig }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/signal' || url.pathname.startsWith('/signal/')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('esperado WebSocket', { status: 426 });
      }

      /*
        Origem no upgrade, antes de acordar o Durable Object (TELA-019). A do
        próprio Worker sempre passa — ele serve o front —; outras só pela
        lista. Não é autenticação: é o que impede uma página de terceiros de
        abrir sinalização em nome de quem a visita.
      */
      if (!origemPermitida(request.headers.get('Origin'), listaDeOrigens(env.ALLOWED_ORIGINS), url.origin)) {
        return new Response('origem não permitida', { status: 403 });
      }

      // S-02: o IP vem da borda, e a abertura tem teto por IP antes de acordar objeto algum.
      const ip = request.headers.get('CF-Connecting-IP');
      if (!(await aberturaPermitida(makeIpGate(env.IP_LIMITER), ip, DEFAULT_LIMITS))) {
        return new Response('muitas conexões', { status: 429 });
      }

      // O slug decide QUAL Durable Object atende, então todos os peers de um
      // canal caem na mesma instância sem roteamento nosso.
      const slug = url.pathname.replace(/^\/signal\/?/, '').toLowerCase();
      if (!SLUG_RE.test(slug)) return new Response('slug inválido', { status: 400 });

      const id = env.CHANNELS.idFromName(slug);
      const headers = new Headers(request.headers);
      headers.set(SLUG_HEADER, slug);
      if (ip === null || ip === '') headers.delete(IP_HEADER);
      else headers.set(IP_HEADER, ip);

      return await env.CHANNELS.get(id).fetch(new Request(request.url, { headers }));
    }

    // O `/tela` do Discord (docs/DISCORD.md). Sem a chave pública, 404.
    if (url.pathname === '/discord/interactions') {
      return await atenderInteracao(request, {
        config: lerConfigDoDiscord(env),
        subtle: crypto.subtle,
        consultar: consultaDoIsolate(env),
      });
    }

    /**
     * Todo o resto é o front estático, servido pelo MESMO Worker.
     *
     * Uma origem só: o WebSocket vira `wss://<host>/signal/<slug>` sem CORS,
     * sem variável de build e sem uma segunda publicação para esquecer de
     * fazer. E requisição de asset estático não conta na cota de Workers.
     */
    const assets = env.ASSETS;
    if (assets !== undefined) {
      // `/<slug>` pedido por robô de prévia ganha o estado do canal; o resto
      // passa direto. Ver `previa.ts`.
      return await servirComPrevia(request, {
        assets: (pedido) => assets.fetch(pedido),
        consultar: consultaDoIsolate(env),
        reescritor: () => new HTMLRewriter(),
      });
    }
    return new Response('front não publicado neste Worker', { status: 404 });
  },
};
