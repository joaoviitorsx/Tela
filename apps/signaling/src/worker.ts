import {
  type ClientMessage,
  ClientMessageSchema,
  type IceServerConfig,
  MAX_FRAME_BYTES,
  SLUG_RE,
  type ServerMessage,
  type SignalingErrorCode,
  isBlockedSlug,
} from '@tela/shared';
import { DEFAULT_LIMITS, type Limits } from './limits.js';

/**
 * Servidor de sinalização em Cloudflare Workers + Durable Objects.
 *
 * # Por que existe um segundo ponto de entrada
 *
 * `server.ts` é o servidor portátil (Node + `ws`) e roda em qualquer lugar que
 * rode Node. Este arquivo existe porque o Cloudflare é o único free tier que
 * atende os três requisitos ao mesmo tempo: gratuito de verdade, sem cartão, e
 * sem dormir de um jeito que derrube conexão aberta (ADR 0007).
 *
 * # Por que a lógica não é compartilhada com o registry
 *
 * O modelo de estado é genuinamente diferente, não é preguiça. Com
 * **WebSocket Hibernation**, o Durable Object é despejado da memória enquanto
 * as conexões continuam abertas — variável de instância e closure somem. A
 * fonte da verdade passa a ser `ctx.getWebSockets()` mais o que foi anexado a
 * cada socket com `serializeAttachment`.
 *
 * O registry do Node guarda `Map` e closures; aqui não existe nem um nem
 * outro. Forçar um denominador comum deixaria os dois piores.
 *
 * O que É compartilhado — e é o que importa — são os SCHEMAS do protocolo
 * (`@tela/shared`) e os limites. E há uma suíte de conformidade que roda as
 * mesmas expectativas de comportamento contra as duas implementações, para
 * que elas não divirjam em silêncio.
 *
 * # Um Durable Object por slug
 *
 * `idFromName(slug)` faz todos os peers de um canal caírem na mesma instância,
 * sem nenhum roteamento nosso. Isolamento por canal sai de graça.
 *
 * REGRA R8: o `payload` atravessa opaco. Este arquivo nunca olha dentro.
 */

/**
 * O que fica preso a cada socket e sobrevive à hibernação.
 *
 * Tudo que o objeto precisa saber e não pode perder mora AQUI. Variável de
 * instância não serve: com WebSocket Hibernation o Durable Object é despejado
 * da memória enquanto os sockets seguem abertos, e ao acordar só existe
 * `getWebSockets()` mais os attachments.
 *
 * O `ownerHash` viajava numa variável de instância, e depois do despejo ele
 * voltava `null` — momento em que a checagem de dono passava a aceitar
 * qualquer um, e um estranho derrubava o transmissor e assumia o canal ao
 * vivo. Agora ele viaja com o socket do host.
 */
type Attachment = {
  readonly peerId: string;
  readonly role: 'host' | 'viewer';
  /** Só no socket do host: sha256 do ownerToken de quem reivindicou. */
  readonly ownerHash?: string;
  /** Janela de rate limit desta conexão, também à prova de hibernação. */
  readonly janelaInicio: number;
  readonly janelaContagem: number;
};

export type Env = {
  CHANNELS: DurableObjectNamespace;
  /** Front estático servido pelo mesmo Worker. Ver `wrangler.toml`. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  MAX_PEERS?: string;
  STUN_URLS?: string;
  TURN_URL?: string;
  TURN_SECRET?: string;
  TURN_TTL_SECONDS?: string;
  /**
   * Cloudflare Realtime TURN.
   *
   * Sem relay, um par atrás de NAT restritivo dos dois lados nunca fecha
   * conexão direta — o WebRTC troca SDP, monta tudo, e nenhum pacote
   * atravessa. O espectador fica olhando para uma tela preta.
   *
   * O serviço da Cloudflare tem 1.000 GB grátis por mês, e as credenciais são
   * efêmeras por peer. Configure com:
   *   wrangler secret put TURN_KEY_ID
   *   wrangler secret put TURN_KEY_API_TOKEN
   */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
};

/* ─────────────────────────── tipos mínimos da plataforma ─────────────────────────── */

export type HibernatableSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

export type DurableContext = {
  acceptWebSocket(socket: HibernatableSocket): void;
  getWebSockets(): HibernatableSocket[];
  /**
   * Armazenamento do objeto. Guarda UMA coisa: o dono do canal durante a
   * carência depois que o transmissor sai.
   *
   * Sem isso, um refresh de página devolveria o slug ao primeiro estranho que
   * o pedisse — e o link já mandado aos amigos passaria a apontar para outra
   * transmissão. É o mesmo comportamento do servidor Node, que as duas
   * implementações precisam ter.
   */
  storage?: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
};

export type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

/* ─────────────────────────── a lógica do canal ─────────────────────────── */

export type ChannelDeps = {
  readonly limits: Limits;
  /**
   * Assíncrono porque o runtime do Worker só tem WebCrypto, que é assíncrono.
   * Guardar o token cru para comparar depois seria mais simples e seria
   * errado: a credencial não precisa existir em memória além do instante em
   * que é verificada.
   */
  readonly hash: (input: string) => Promise<string>;
  readonly equals: (a: string, b: string) => boolean;
  readonly iceServersFor: (peerId: string) => Promise<IceServerConfig[]>;
  readonly newPeerId: (prefix: string) => string;
};

/**
 * Estado que NÃO cabe no socket e precisa sobreviver à hibernação: quem é o
 * dono do canal. Vive na memória do objeto e é re-hidratado do primeiro socket
 * de host que existir — se não houver nenhum, o canal está livre, que é
 * exatamente a semântica desejada.
 */
/**
 * Depois que o transmissor sai, o canal guarda o dono por este tempo.
 *
 * Mesmo valor do servidor Node: as duas implementações precisam ter a mesma
 * semântica, senão o comportamento do produto muda com o lugar do deploy.
 */
export const OWNERSHIP_GRACE_MS = 5 * 60_000;

type PosseGuardada = { readonly ownerHash: string; readonly ate: number };

const CHAVE_POSSE = 'posse';

export class ChannelRoom {
  constructor(
    private readonly ctx: DurableContext,
    private readonly deps: ChannelDeps,
  ) {}

  private send(socket: HibernatableSocket, message: ServerMessage): void {
    socket.send(JSON.stringify(message));
  }

  private fail(socket: HibernatableSocket, code: SignalingErrorCode): void {
    this.send(socket, { type: 'error', code });
    socket.close(1008, code);
  }

  private attachmentOf(socket: HibernatableSocket): Attachment | null {
    const raw = socket.deserializeAttachment();
    if (typeof raw !== 'object' || raw === null) return null;
    const value = raw as Attachment;
    return typeof value.peerId === 'string' ? value : null;
  }

  /**
   * Quem é o dono deste canal, sobrevivendo à hibernação.
   *
   * Primeiro o socket do host, que carrega o hash consigo. Se não houver host
   * conectado, o armazenamento — que guarda a posse pela carência, para um
   * refresh de página não entregar o slug a um estranho.
   */
  private async donoAtual(): Promise<string | null> {
    const host = this.host();
    if (host !== null && typeof host.at.ownerHash === 'string') return host.at.ownerHash;

    const guardada = await this.ctx.storage?.get<PosseGuardada>(CHAVE_POSSE);
    if (guardada === undefined) return null;
    if (guardada.ate <= Date.now()) {
      await this.ctx.storage?.delete(CHAVE_POSSE);
      return null;
    }
    return guardada.ownerHash;
  }

  private peers(): { socket: HibernatableSocket; at: Attachment }[] {
    const out: { socket: HibernatableSocket; at: Attachment }[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const at = this.attachmentOf(socket);
      if (at !== null) out.push({ socket, at });
    }
    return out;
  }

  private host(): { socket: HibernatableSocket; at: Attachment } | null {
    return this.peers().find((p) => p.at.role === 'host') ?? null;
  }

  private viewers(): { socket: HibernatableSocket; at: Attachment }[] {
    return this.peers().filter((p) => p.at.role === 'viewer');
  }

  accept(socket: HibernatableSocket): void {
    this.ctx.acceptWebSocket(socket);
  }

  /** Chamado por `webSocketMessage`. `slug` vem da URL, não do cliente. */
  async handleMessage(socket: HibernatableSocket, slug: string, raw: string): Promise<void> {
    if (raw.length > MAX_FRAME_BYTES) {
      return this.fail(socket, 'BAD_MESSAGE');
    }
    if (!this.dentroDoLimite(socket)) return this.fail(socket, 'RATE_LIMITED');

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.fail(socket, 'BAD_MESSAGE');
    }

    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) return this.fail(socket, 'BAD_MESSAGE');

    const message = parsed.data;
    const at = this.attachmentOf(socket);

    switch (message.type) {
      case 'host':
        if (at !== null) return;
        return await this.claim(socket, slug, message.slug, message.ownerToken);
      case 'watch':
        if (at !== null) return;
        return await this.join(socket, slug, message.slug);
      case 'signal':
        if (at === null) return this.fail(socket, 'BAD_MESSAGE');
        return this.relay(at, message);
      case 'leave':
        socket.close(1000, 'leave');
        return;
    }
  }

  /**
   * Rate limit por conexão, guardado no attachment.
   *
   * Contador em variável de instância não sobreviveria à hibernação, e o
   * servidor ficaria sem proteção nenhuma justamente no caminho que a
   * plataforma mais usa. O attachment viaja com o socket.
   *
   * O teto é o mesmo do servidor Node: a troca de ICE é em rajada, e um teto
   * pensado para tráfego constante derrubaria transmissões legítimas.
   */
  private dentroDoLimite(socket: HibernatableSocket): boolean {
    const at = this.attachmentOf(socket);
    if (at === null) return true; // ainda não se apresentou; `claim`/`join` limitam

    const agora = Date.now();
    const reiniciou = agora - at.janelaInicio >= this.deps.limits.messageWindowMs;
    const contagem = reiniciou ? 1 : at.janelaContagem + 1;

    socket.serializeAttachment({
      ...at,
      janelaInicio: reiniciou ? agora : at.janelaInicio,
      janelaContagem: contagem,
    } satisfies Attachment);

    return contagem <= this.deps.limits.messageLimit;
  }

  private async claim(
    socket: HibernatableSocket,
    slug: string,
    claimed: string,
    ownerToken: string,
  ): Promise<void> {
    // O slug do Durable Object vence: ele veio da URL e determinou qual
    // instância atendeu. Divergir significa cliente confuso ou malicioso.
    // A blocklist vale no SERVIDOR, não só no formulário: pelo WebSocket cru
    // qualquer um pediria `api` ou `admin`.
    if (claimed !== slug || !SLUG_RE.test(slug) || isBlockedSlug(slug)) {
      return this.fail(socket, 'SLUG_INVALID');
    }

    const hash = await this.deps.hash(ownerToken);
    const dono = await this.donoAtual();

    // Existe dono e não é você: o canal é de outra pessoa, com ou sem alguém
    // conectado neste instante.
    if (dono !== null && !this.deps.equals(dono, hash)) {
      return this.fail(socket, 'SLUG_TAKEN');
    }

    /**
     * A ORDEM importa: o socket novo assume ANTES de o antigo ser derrubado.
     *
     * Fechar primeiro dispara o `webSocketClose` do antigo enquanto o novo
     * ainda não tem attachment — e o objeto, sem enxergar host algum,
     * concluía que o transmissor tinha ido embora e derrubava todos os
     * espectadores. Quem dava F5 perdia a audiência.
     */
    const anterior = this.host();
    const peerId = this.deps.newPeerId('h');
    socket.serializeAttachment({
      peerId,
      role: 'host',
      ownerHash: hash,
      janelaInicio: Date.now(),
      janelaContagem: 0,
    } satisfies Attachment);

    // Mesmo dono reconectando (refresh, troca de rede): derruba o antigo.
    anterior?.socket.close(1000, 'substituido');

    this.send(socket, {
      type: 'hosting',
      peerId,
      iceServers: await this.deps.iceServersFor(peerId),
      maxPeers: this.deps.limits.maxPeers,
    });

    /**
     * O host novo precisa saber quem JÁ está no canal.
     *
     * Ele é quem oferece a mídia. Sem esta reapresentação, um transmissor que
     * reconectou nunca ofertava para quem já estava assistindo — o espectador
     * segurava uma vaga com uma conexão morta até o ICE desistir, e nada na
     * tela explicava por quê.
     */
    for (const viewer of this.viewers()) {
      this.send(socket, { type: 'peer-joined', peerId: viewer.at.peerId });
    }
  }

  private async join(socket: HibernatableSocket, slug: string, wanted: string): Promise<void> {
    if (wanted !== slug || !SLUG_RE.test(slug)) return this.fail(socket, 'SLUG_INVALID');

    const host = this.host();
    // Slug inválido, inexistente e offline devolvem o MESMO erro: quem varre
    // nomes não distingue "não existe" de "existe e está fora do ar".
    if (host === null) return this.fail(socket, 'NOT_HOSTING');
    if (this.viewers().length >= this.deps.limits.maxPeers) {
      return this.fail(socket, 'CHANNEL_FULL');
    }

    const peerId = this.deps.newPeerId('v');
    socket.serializeAttachment({
      peerId,
      role: 'viewer',
      janelaInicio: Date.now(),
      janelaContagem: 0,
    } satisfies Attachment);

    this.send(socket, {
      type: 'watching',
      peerId,
      hostId: host.at.peerId,
      iceServers: await this.deps.iceServersFor(peerId),
    });
    // O transmissor é quem oferece — ele tem a mídia.
    this.send(host.socket, { type: 'peer-joined', peerId });
  }

  private relay(from: Attachment, message: Extract<ClientMessage, { type: 'signal' }>): void {
    // Espectador só fala com o transmissor; transmissor endereça por `to`.
    const target =
      from.role === 'viewer'
        ? this.host()
        : (this.viewers().find((v) => v.at.peerId === message.to) ?? null);
    if (target === null) return;

    // `payload` atravessa sem ser lido. R8.
    this.send(target.socket, { type: 'signal', from: from.peerId, payload: message.payload });
  }

  /** Chamado por `webSocketClose` e `webSocketError`. */
  handleClose(socket: HibernatableSocket): void {
    const at = this.attachmentOf(socket);
    if (at === null) return;

    if (at.role === 'host' && typeof at.ownerHash === 'string') {
      /**
       * Guarda a posse pela carência.
       *
       * Sem isso, um refresh de página devolveria o slug ao primeiro estranho
       * que o pedisse, e o link que a pessoa já mandou para os amigos passaria
       * a apontar para outra transmissão.
       */
      void this.ctx.storage?.put<PosseGuardada>(CHAVE_POSSE, {
        ownerHash: at.ownerHash,
        ate: Date.now() + OWNERSHIP_GRACE_MS,
      });
    }

    if (at.role === 'host') {
      /**
       * Socket de host JÁ SUBSTITUÍDO não derruba nada.
       *
       * Quando o dono reconecta — refresh, troca de rede — o socket antigo
       * fecha e o `webSocketClose` dele chega depois. Sem esta checagem, o
       * fechamento atrasado do socket velho derrubava todos os espectadores
       * do host NOVO: a pessoa dava F5 e perdia a audiência.
       */
      if (this.host() !== null) return;

      // Transmissor saiu de verdade: avisa ANTES de fechar. Socket fechado em
      // silêncio não distingue "o transmissor saiu" de "o servidor caiu", e as
      // duas coisas pedem reações opostas.
      for (const viewer of this.viewers()) {
        this.send(viewer.socket, { type: 'peer-left', peerId: at.peerId });
        viewer.socket.close(1000, 'host saiu');
      }
      return;
    }

    const host = this.host();
    if (host !== null) this.send(host.socket, { type: 'peer-left', peerId: at.peerId });
  }
}


/* ─────────────────────────── criptografia do Worker ─────────────────────────── */

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Comparação em tempo constante sem `node:crypto`.
 *
 * O runtime do Worker não tem `timingSafeEqual`. O XOR acumulado percorre a
 * string inteira sempre, então o tempo não depende de quantos caracteres
 * iniciais o atacante acertou — que é a propriedade que importa.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * O subconjunto de WebCrypto que este arquivo usa.
 *
 * Declarado à mão porque o pacote compila com `types: ["node"]` — puxar a lib
 * DOM inteira só para uma interface traria `window`, `document` e a tentação
 * de usá-los num servidor.
 */
type Bytes = Uint8Array | ArrayBuffer;
type OpaqueKey = { readonly __key?: unique symbol };

export type WebCryptoLike = {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: {
    digest(algorithm: string, data: Bytes): Promise<ArrayBuffer>;
    importKey(
      format: 'raw',
      keyData: Bytes,
      algorithm: { name: string; hash: string },
      extractable: boolean,
      usages: string[],
    ): Promise<OpaqueKey>;
    sign(algorithm: string, key: OpaqueKey, data: Bytes): Promise<ArrayBuffer>;
  };
};

export function makeChannelDeps(env: Env, crypto: WebCryptoLike): ChannelDeps {
  const parsedMax = Number(env.MAX_PEERS ?? DEFAULT_LIMITS.maxPeers);
  const stun = (env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  const encoder = new TextEncoder();

  return {
    limits: {
      ...DEFAULT_LIMITS,
      maxPeers: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_LIMITS.maxPeers,
    },

    async hash(input) {
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
      return toHex(new Uint8Array(digest));
    },

    equals: constantTimeEquals,

    newPeerId(prefix) {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      let out = '';
      for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
      return `${prefix}_${out}`;
    },

    async iceServersFor(peerId) {
      const servers: IceServerConfig[] = [{ urls: stun }];

      const cloudflare = await cloudflareTurn(env, ttlSegundos(env));
      if (cloudflare !== null) {
        servers.push(cloudflare);
        return servers;
      }

      if (env.TURN_URL === undefined || env.TURN_SECRET === undefined) return servers;

      // `use-auth-secret` do coturn: usuário e senha derivados, com validade
      // curta. Credencial estática num front público é um relay aberto para a
      // internet inteira, rodando na sua cota.
      const ttl = ttlSegundos(env);
      const expiry = Math.floor(Date.now() / 1000) + ttl;
      const username = `${expiry}:${peerId}`;

      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.TURN_SECRET),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign'],
      );
      const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(username));

      servers.push({
        urls: [env.TURN_URL],
        username,
        credential: toBase64(new Uint8Array(signature)),
      });
      return servers;
    },
  };
}


function ttlSegundos(env: Env): number {
  const bruto = Number(env.TURN_TTL_SECONDS ?? 600);
  return Number.isFinite(bruto) && bruto > 0 ? bruto : 600;
}

/**
 * Credenciais efêmeras do Cloudflare Realtime TURN.
 *
 * Uma requisição por peer que entra — barata e cacheável, mas mesmo sem cache
 * é uma chamada por espectador, não por pacote. Falha em silêncio: se o TURN
 * não puder ser obtido, a conexão ainda pode fechar direto, e derrubar a
 * entrada por causa disso seria trocar uma degradação por uma falha.
 */
async function cloudflareTurn(env: Env, ttl: number): Promise<IceServerConfig | null> {
  const { TURN_KEY_ID: id, TURN_KEY_API_TOKEN: token } = env;
  if (id === undefined || token === undefined) return null;

  try {
    const resposta = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl }),
      },
    );
    if (!resposta.ok) return null;

    const corpo = (await resposta.json()) as { iceServers?: IceServerConfig };
    const servidores = corpo.iceServers;
    if (servidores === undefined || servidores.urls === undefined) return null;
    return servidores;
  } catch {
    return null;
  }
}
