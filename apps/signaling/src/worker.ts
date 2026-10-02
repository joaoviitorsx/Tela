import {
  type ClientMessage,
  ClientMessageSchema,
  HELLO_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  P2P_LIMITS,
  PROTOCOL_VERSION,
  SLUG_RE,
  type ServerMessage,
  type SignalingErrorCode,
  apelidoUnico,
  isBlockedSlug,
} from '@tela/shared';
import { DEFAULT_LIMITS, type Limits } from './limits.js';
import { type IceSettings, parseIceSettings } from './ice-settings.js';
import { makeCloudflareProvider, type IceProvisionResult } from './ice-provision.js';
import type { EnvDoDiscord } from './discord-config.js';

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
  readonly participantId?: string;
  readonly attemptId?: string;
  /** Reserva de vaga durante a emissão TURN; oferta só depois de `watching`. */
  readonly ready?: boolean;
  /**
   * Pedido na mão do transmissor (ADR 0025): sem vaga, sem credencial, sem
   * sinal. No attachment porque o objeto hiberna enquanto a pessoa espera — e
   * esperar é justamente o que um pedido faz.
   */
  readonly pendente?: boolean;
  /** Só espectador: apelido e sha256 da chave do navegador. */
  readonly name?: string;
  readonly fingerprint?: string;
  /** Só no socket do host: sha256 do ownerToken de quem reivindicou. */
  readonly ownerHash?: string;
  /**
   * Só no socket do host: a sala pede aprovação de cada espectador (ADR 0025)?
   * Ausente = aberta (ADR 0028). Mora no attachment pela hibernação.
   */
  readonly aprovacao?: boolean;
  /**
   * Só no socket do host: a `capacidade` que ele declarou (ADR 0029). O teto
   * do canal é o menor entre ela e o do servidor. Mora no attachment porque o
   * teto precisa valer depois da hibernação, quando o `claim` já é passado.
   */
  readonly capacidade?: number;
  /**
   * Só no socket do host: o que a BANDA dele paga agora (ADR 0030), mandado
   * por `capacidade` ao longo da transmissão. Nunca acima de `capacidade`.
   * No attachment pelo mesmo motivo: o teto tem de valer depois de hibernar.
   */
  readonly tetoPelaBanda?: number;
  /** Tirado pelo transmissor: some da plateia na hora, antes do close chegar. */
  readonly removido?: boolean;
  /** Janela de rate limit desta conexão, também à prova de hibernação. */
  /**
   * `leave` recebido antes do fechamento: saída ANUNCIADA.
   *
   * Vive no attachment porque o objeto hiberna: variável de instância não
   * sobrevive entre a mensagem e o `webSocketClose`.
   */
  readonly saiuDeProposito?: boolean;
  readonly janelaInicio: number;
  readonly janelaContagem: number;
  /**
   * `CF-Connecting-IP` da conexão (S-02/S-07). No attachment pela hibernação.
   * Ausente só fora da Cloudflare (teste, `wrangler dev` sem proxy): aí os
   * limites por IP não se aplicam — melhor sem o freio que um balde "IP
   * desconhecido" compartilhado por todo mundo.
   */
  readonly ip?: string;
  /** Bytes de `signal` que o ESPECTADOR mandou ao host na janela (S-07). */
  readonly janelaBytes?: number;
  /** Janela e contagem de `refresh-ice` desta conexão (S-02). */
  readonly refreshInicio?: number;
  readonly refreshN?: number;
};

export type Env = {
  CHANNELS: DurableObjectNamespace;
  /** Front estático servido pelo mesmo Worker. Ver `wrangler.toml`. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  MAX_PEERS?: string;
  /** Assentos por IP e canal na sala aberta (S-07). Padrão: `DEFAULT_LIMITS.viewersPorIp`. */
  MAX_VIEWERS_PER_IP?: string;
  STUN_URLS?: string;
  ICE_PROVIDER?: string;
  TURN_URL?: string;
  TURN_URLS?: string;
  TURN_SECRET?: string;
  TURN_TTL_SECONDS?: string;
  TURN_FETCH_TIMEOUT_MS?: string;
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
  /**
   * Origens extras que podem abrir o WebSocket, separadas por vírgula. A
   * origem do próprio Worker, que serve o front, já passa (TELA-019).
   */
  ALLOWED_ORIGINS?: string;
  /**
   * Contador de abuso por IP, um Durable Object por IP (S-02). O objeto do
   * canal é por slug e não enxerga o que o mesmo IP faz em outros; este, sim.
   * Ausente = sem limite entre canais (os limites DENTRO do canal seguem).
   */
  IP_LIMITER?: DurableObjectNamespace;
} & EnvDoDiscord;

/**
 * Socket que ainda não se apresentou. Vive no attachment pelo mesmo motivo de
 * tudo aqui: timer de instância não sobrevive à hibernação, e um socket que
 * abre e nunca fala seguraria recurso para sempre.
 */
type PreAttachment = {
  /** Quando abriu. O alarme derruba quem passar do prazo sem saudação. */
  readonly aguardandoDesde?: number;
  readonly ip?: string;
  /** Já mandou `host`/`watch` e está no meio do `await`. */
  readonly apresentando?: true;
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
   * Exclusão mútua de verdade dentro do objeto.
   *
   * Os "input gates" do runtime só protegem durante operações de STORAGE.
   * Qualquer outro `await` — um `fetch`, um `crypto.subtle.digest` — devolve
   * o loop e deixa outra requisição entrar no meio. É o bastante para um
   * `check-then-act` como o do `claim` ser vencido por quem chegou depois.
   */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
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
    deleteAll?(): Promise<void>;
    /** Alarme do objeto: o único relógio que sobrevive à hibernação. */
    getAlarm?(): Promise<number | null>;
    setAlarm?(quando: number): Promise<void>;
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
  readonly iceServersFor: (peerId: string) => Promise<IceProvisionResult>;
  readonly newPeerId: (prefix: string) => string;
  /**
   * Balde por IP compartilhado entre canais (S-02). `true` = permitido.
   * Opcional: sem ele (teste, Worker sem o binding) só valem os limites do
   * próprio canal. Falha de infraestrutura devolve `true`: o freio de abuso
   * não pode virar a causa de indisponibilidade.
   */
  readonly ipGate?: (ip: string, chave: string, limite: number, janelaMs: number) => Promise<boolean>;
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
const CHAVE_FALHAS = 'falhas';

type JanelaClaims = { readonly inicio: number; readonly n: number };

/**
 * Contador de abuso de UM IP (um Durable Object por IP, ver `IP_LIMITER`).
 *
 * Janela fixa por chave, gravada no storage para sobreviver ao despejo do
 * objeto. O alarme apaga tudo quando a maior janela passa: sem ele, cada IP
 * que já falou conosco deixaria linhas para sempre.
 */
export class IpLimiter {
  constructor(private readonly ctx: Pick<DurableContext, 'storage'>) {}

  async take(chave: string, limite: number, janelaMs: number, agora: number = Date.now()): Promise<boolean> {
    const storage = this.ctx.storage;
    if (storage === undefined) return true;
    const guardado = await storage.get<JanelaClaims>(`b:${chave}`);
    const janela = guardado === undefined || agora - guardado.inicio >= janelaMs
      ? { inicio: agora, n: 0 }
      : guardado;
    const n = janela.n + 1;
    await storage.put(`b:${chave}`, { inicio: janela.inicio, n });
    if (storage.setAlarm !== undefined) {
      const atual = (await storage.getAlarm?.()) ?? null;
      const fim = janela.inicio + janelaMs + 1_000;
      if (atual === null || atual < fim) await storage.setAlarm(fim);
    }
    return n <= limite;
  }

  /** Chamado pelo `alarm()`: tudo o que havia já expirou (cada janela é <= ao alarme). */
  async limpar(): Promise<void> {
    await this.ctx.storage?.deleteAll?.();
  }
}

/** Ver `ChannelRoom.estadoPublico`. */
export type EstadoPublico = { readonly noAr: boolean; readonly espectadores: number };

export class ChannelRoom {
  constructor(
    private readonly ctx: DurableContext,
    private readonly deps: ChannelDeps,
  ) {}

  private send(socket: HibernatableSocket, message: ServerMessage): void {
    socket.send(JSON.stringify(message));
  }

  /** `maxPeers` só acompanha `CHANNEL_FULL`: o teto real, para a tela de "sem vaga". */
  private fail(socket: HibernatableSocket, code: SignalingErrorCode, maxPeers?: number): void {
    this.send(socket, { type: 'error', code, ...(maxPeers === undefined ? {} : { maxPeers }) });
    // Sai do índice já: o runtime pode demorar a entregar o `webSocketClose`.
    this.esquecer(socket);
    socket.close(1008, code);
  }

  /**
   * Teto de espectadores DESTE canal: o menor entre o do servidor e a
   * `capacidade` do transmissor atual (ADR 0029). Sem declaração, o teto de
   * quem codifica uma vez por espectador: cliente antigo só conhecia cinco.
   */
  private teto(): number {
    const host = this.host();
    const maquina = this.tetoPara(host?.at.capacidade);
    // Servidor, máquina e banda: o menor dos três. A banda só fecha vagas.
    return host?.at.tetoPelaBanda === undefined ? maquina : Math.min(maquina, host.at.tetoPelaBanda);
  }

  private tetoPara(capacidade: number | undefined): number {
    return Math.min(this.deps.limits.maxPeers, capacidade ?? P2P_LIMITS.maxViewersSemUmEncode);
  }

  /** Leitura crua do attachment: uma desserialização, só do socket pedido. */
  private attachmentOf(socket: HibernatableSocket): Attachment | null {
    const raw = socket.deserializeAttachment();
    if (typeof raw !== 'object' || raw === null) return null;
    const value = raw as Attachment;
    return typeof value.peerId === 'string' ? value : null;
  }

  /*
    Índice em memória dos attachments (ADR 0031, C2).

    ESTADO DERIVADO, nunca fonte da verdade: a verdade continua sendo
    `getWebSockets()` mais `serializeAttachment`. Antes, cada consulta
    desserializava o attachment de TODOS os sockets, e `relay()` fazia isso
    duas vezes por sinal — O(N) por mensagem, O(N²) numa entrada em massa.
    Agora a varredura acontece UMA vez (`indice()` na primeira consulta de uma
    instância nova, que é exatamente o que a hibernação produz) e daí em diante
    o índice acompanha cada escrita (`gravar`) e cada saída (`esquecer`).

    Regra de ouro: nenhum `serializeAttachment` de attachment completo fora de
    `gravar`. Quem esquecer deixa o índice mentir.
  */
  private porSocket: Map<HibernatableSocket, Attachment> | null = null;
  /** peerId -> socket; sem duplicata em regime, só durante a troca de socket do mesmo peer. */
  private porPeer = new Map<string, HibernatableSocket>();
  /** O host mais antigo, como o `find` sobre `getWebSockets()` devolvia. */
  private socketDoHost: HibernatableSocket | null = null;

  private indice(): Map<HibernatableSocket, Attachment> {
    if (this.porSocket !== null) return this.porSocket;
    const mapa = new Map<HibernatableSocket, Attachment>();
    this.porSocket = mapa;
    this.porPeer = new Map();
    this.socketDoHost = null;
    for (const socket of this.ctx.getWebSockets()) {
      const at = this.attachmentOf(socket);
      if (at !== null) this.indexar(socket, at);
    }
    return mapa;
  }

  private indexar(socket: HibernatableSocket, at: Attachment): void {
    const mapa = this.porSocket;
    if (mapa === null) return;
    mapa.set(socket, at);
    this.porPeer.set(at.peerId, socket);
    if (at.role === 'host' && this.socketDoHost === null) this.socketDoHost = socket;
  }

  /** Único ponto de escrita de attachment completo: grava e mantém o índice. */
  private gravar(socket: HibernatableSocket, at: Attachment): void {
    socket.serializeAttachment(at);
    // Índice ainda não construído: a próxima consulta lê tudo do zero.
    if (this.porSocket !== null) this.indexar(socket, at);
  }

  /** Socket que fechou (ou está fechando): sai do índice. Idempotente. */
  private esquecer(socket: HibernatableSocket): void {
    const mapa = this.porSocket;
    const at = mapa?.get(socket);
    if (mapa === null || at === undefined) return;
    mapa.delete(socket);
    if (this.porPeer.get(at.peerId) === socket) {
      this.porPeer.delete(at.peerId);
      // O mesmo peer pode ter outro socket (retomada): ele passa a valer.
      for (const [outro, o] of mapa) {
        if (o.peerId === at.peerId) this.porPeer.set(at.peerId, outro);
      }
    }
    if (this.socketDoHost === socket) {
      this.socketDoHost = null;
      for (const [outro, o] of mapa) {
        if (o.role === 'host') {
          this.socketDoHost = outro;
          break;
        }
      }
    }
  }

  /** Attachment atual do socket, em O(1). `null` = ainda não se apresentou. */
  private atual(socket: HibernatableSocket): Attachment | null {
    return this.indice().get(socket) ?? null;
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
    for (const [socket, at] of this.indice()) out.push({ socket, at });
    return out;
  }

  private host(): { socket: HibernatableSocket; at: Attachment } | null {
    const indice = this.indice();
    const socket = this.socketDoHost;
    const at = socket === null ? undefined : indice.get(socket);
    return socket === null || at === undefined ? null : { socket, at };
  }

  private viewers(): { socket: HibernatableSocket; at: Attachment }[] {
    return this.peers().filter((p) => p.at.role === 'viewer' && p.at.removido !== true && p.at.pendente !== true);
  }

  private pedidos(): { socket: HibernatableSocket; at: Attachment }[] {
    return this.peers().filter((p) => p.at.role === 'viewer' && p.at.removido !== true && p.at.pendente === true);
  }

  private pedidoParaHost(at: Attachment): ServerMessage {
    return {
      type: 'join-request', peerId: at.peerId, name: at.name ?? '?', fingerprint: at.fingerprint ?? '',
    };
  }

  /** O que o transmissor precisa para reconhecer um espectador. */
  private quemE(at: Attachment): { name?: string; fingerprint?: string } {
    return {
      ...(at.name === undefined ? {} : { name: at.name }),
      ...(at.fingerprint === undefined ? {} : { fingerprint: at.fingerprint }),
    };
  }

  /** Versão do cliente: sem o campo é v1, recusado com código que ele entende. */
  private versaoRecusada(protocol: number | undefined): SignalingErrorCode | null {
    if (protocol === undefined) return 'BAD_MESSAGE';
    return protocol === PROTOCOL_VERSION ? null : 'PROTOCOL_MISMATCH';
  }

  /**
   * O que a prévia do link e o `/tela` do Discord podem saber do canal: se
   * alguém transmite e QUANTOS assistem. Só leitura, sem storage, sem `await`.
   *
   * Nada de nome, IP ou impressão de espectador: a resposta sai do servidor
   * para quem colou o link, e quem colou não precisa saber quem está lá.
   * O número é o mesmo que a plateia recebe em `viewers` — pedido pendente
   * (ADR 0025) ainda não assiste, e não conta.
   *
   * "No ar" é ter host conectado: o cliente só reivindica o canal DEPOIS da
   * captura (`BroadcastSession.start`), então host sem tela não existe.
   */
  estadoPublico(): EstadoPublico {
    return { noAr: this.host() !== null, espectadores: this.viewers().length };
  }

  accept(socket: HibernatableSocket, ip?: string): void {
    this.ctx.acceptWebSocket(socket);
    socket.serializeAttachment({
      aguardandoDesde: Date.now(), ...(ip === undefined ? {} : { ip }),
    } satisfies PreAttachment);
    void this.agendarExpiracao(Date.now() + HELLO_TIMEOUT_MS);
  }

  private preAttachmentOf(socket: HibernatableSocket): PreAttachment | null {
    if (this.atual(socket) !== null) return null;
    const raw = socket.deserializeAttachment();
    return typeof raw === 'object' && raw !== null ? (raw as PreAttachment) : {};
  }

  /** Mantém o alarme no mais cedo que falta vencer. */
  private async agendarExpiracao(quando: number): Promise<void> {
    const storage = this.ctx.storage;
    if (storage?.setAlarm === undefined) return;
    const atual = (await storage.getAlarm?.()) ?? null;
    if (atual === null || atual > quando) await storage.setAlarm(quando);
  }

  /**
   * Chamado pelo `alarm()` do objeto (TELA-019, §9.2): derruba quem abriu e
   * não se apresentou no prazo — o equivalente ao `HELLO_TIMEOUT` do Node, que
   * lá é um `setTimeout` e aqui não pode ser.
   *
   * Só expira quem NÃO mandou saudação. Quem está no meio de um `host` ou
   * `watch` tem o próprio limite: o `await` da emissão TURN, que tem prazo.
   */
  async expirarPendentes(agora: number = Date.now()): Promise<void> {
    let proximo: number | null = null;
    for (const socket of this.ctx.getWebSockets()) {
      const pre = this.preAttachmentOf(socket);
      if (pre === null || pre.apresentando === true || pre.aguardandoDesde === undefined) continue;
      const vence = pre.aguardandoDesde + HELLO_TIMEOUT_MS;
      if (vence <= agora) this.fail(socket, 'HELLO_TIMEOUT');
      else proximo = proximo === null ? vence : Math.min(proximo, vence);
    }
    if (proximo !== null) await this.agendarExpiracao(proximo);
  }

  /** Chamado por `webSocketMessage`. `slug` vem da URL, não do cliente. */
  async handleMessage(socket: HibernatableSocket, slug: string, raw: string): Promise<void> {
    /*
      O teto é em BYTES, como no Node (`maxPayload`). `raw.length` conta
      unidades UTF-16: 40 mil "€" passavam como 40 mil e eram 120 KB. Só mede
      quando o comprimento não prova sozinho que cabe — cada unidade vira no
      máximo 3 bytes.
    */
    if (raw.length * 3 > MAX_FRAME_BYTES && tamanhoEmBytes(raw) > MAX_FRAME_BYTES) {
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
    const at = this.atual(socket);
    // Lido ANTES de o attachment ser trocado pelo de "apresentando"/de peer.
    const ip = at?.ip ?? this.preAttachmentOf(socket)?.ip;

    /*
      Uma saudação por socket, também durante o `await`. Sem isto, três
      `host` seguidos no mesmo socket rodavam três `claim` em paralelo — três
      chamadas pagas à API de TURN antes de qualquer um terminar.
    */
    if ((message.type === 'host' || message.type === 'watch') && at === null) {
      if (this.preAttachmentOf(socket)?.apresentando === true) return this.fail(socket, 'BAD_MESSAGE');
      socket.serializeAttachment({
        apresentando: true, ...(ip === undefined ? {} : { ip }),
      } satisfies PreAttachment);
    }

    switch (message.type) {
      case 'host': {
        if (at !== null) return;
        const versao = this.versaoRecusada(message.protocol);
        if (versao !== null) return this.fail(socket, versao);
        return await this.claim(
          socket, slug, message.slug, message.ownerToken, message.approval === true, message.capacidade, ip,
        );
      }
      case 'watch': {
        if (at !== null) return;
        const versao = this.versaoRecusada(message.protocol);
        if (versao !== null) return this.fail(socket, versao);
        return await this.join(
          socket, slug, message.slug, message.participantId, message.attemptId,
          message.name, message.viewerKey, ip,
        );
      }
      case 'admit':
      case 'deny':
        if (at === null) return this.fail(socket, 'BAD_MESSAGE');
        return await this.responder(socket, at, message.peerId, message.type === 'admit');
      case 'remove-viewers':
        if (at === null) return this.fail(socket, 'BAD_MESSAGE');
        return this.removeViewers(socket, at, message.peerId);
      case 'capacidade':
        if (at === null) return this.fail(socket, 'BAD_MESSAGE');
        return this.atualizarCapacidade(socket, at, message.valor);
      case 'refresh-ice':
        if (at === null || at.ready === false) return this.fail(socket, 'BAD_MESSAGE');
        return await this.refreshIce(socket, at, message.requestId);
      case 'signal':
        if (at === null) return this.fail(socket, 'BAD_MESSAGE');
        return this.relay(socket, at, message, tamanhoEmBytes(raw));
      case 'leave':
        // Marca ANTES de fechar: separa "eu parei" de "meu socket caiu".
        if (at !== null) this.gravar(socket, { ...at, saiuDeProposito: true });
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
    const at = this.atual(socket);
    if (at === null) return true; // ainda não se apresentou; `claim`/`join` limitam

    const agora = Date.now();
    const reiniciou = agora - at.janelaInicio >= this.deps.limits.messageWindowMs;
    const contagem = reiniciou ? 1 : at.janelaContagem + 1;

    this.gravar(socket, {
      ...at,
      janelaInicio: reiniciou ? agora : at.janelaInicio,
      janelaContagem: contagem,
      ...(reiniciou ? { janelaBytes: 0 } : {}),
    } satisfies Attachment);

    // O transmissor negocia com a plateia inteira; o espectador, com um peer.
    const teto = at.role === 'host' ? this.deps.limits.hostMessageLimit : this.deps.limits.messageLimit;
    return contagem <= teto;
  }

  /** Balde por IP entre canais. Sem IP (fora da Cloudflare) ou sem binding: livre. */
  private async gate(ip: string | undefined, chave: string, limite: number, janelaMs: number): Promise<boolean> {
    if (ip === undefined || this.deps.ipGate === undefined) return true;
    return await this.deps.ipGate(ip, chave, limite, janelaMs);
  }

  /**
   * Conta uma reivindicação FALHA (token de dono errado) e diz se ainda está
   * dentro do teto — por slug (storage deste objeto) e por IP (entre canais).
   *
   * Só a falha conta (S-01). Antes, o contador era incrementado por QUALQUER
   * `host`, antes de olhar o dono: 20 tentativas erradas de um estranho
   * trancavam o dono real fora do slug com `RATE_LIMITED`, e a carência de
   * cinco minutos virava a janela para o estranho levar o link. Estourar este
   * teto só troca o erro de quem já erraria (SLUG_TAKEN -> RATE_LIMITED); o
   * token certo nunca chega aqui.
   *
   * Se o storage não existir (driver de teste antigo), deixa passar.
   */
  private async falhaDentroDoTeto(ip: string | undefined): Promise<boolean> {
    const agora = Date.now();
    const guardado = await this.ctx.storage?.get<JanelaClaims>(CHAVE_FALHAS);
    const janela =
      guardado === undefined || agora - guardado.inicio >= this.deps.limits.hostWindowMs
        ? { inicio: agora, n: 0 }
        : guardado;
    await this.ctx.storage?.put(CHAVE_FALHAS, { inicio: janela.inicio, n: janela.n + 1 });
    const porSlug = janela.n + 1 <= this.deps.limits.falhaHostSlugLimit;
    const porIp = await this.gate(ip, 'falha', this.deps.limits.falhaHostLimit, this.deps.limits.hostWindowMs);
    return porSlug && porIp;
  }

  private async claim(
    socket: HibernatableSocket,
    slug: string,
    claimed: string,
    ownerToken: string,
    aprovacao: boolean,
    capacidade: number | undefined,
    ip: string | undefined,
  ): Promise<void> {
    // O slug do Durable Object vence: ele veio da URL e determinou qual
    // instância atendeu. Divergir significa cliente confuso ou malicioso.
    // A blocklist vale no SERVIDOR, não só no formulário: pelo WebSocket cru
    // qualquer um pediria `api` ou `admin`.
    if (claimed !== slug || !SLUG_RE.test(slug) || isBlockedSlug(slug)) {
      return this.fail(socket, 'SLUG_INVALID');
    }

    /*
      S-01: a posse é lida ANTES de qualquer contagem, e só a FALHA conta (ver
      `falhaDentroDoTeto`). O dono verdadeiro passa sempre, por mais que um
      estranho erre; um estranho que nunca teve o token só recebe SLUG_TAKEN
      ou RATE_LIMITED — durante a carência a posse vem do storage, então a
      janela de cinco minutos não é porta aberta.

      Dono errado sai ANTES da emissão TURN (§9.2: não chamar a API paga antes
      de uma autorização viável). A seção crítica abaixo confere de novo — isto
      só evita o gasto no caso óbvio, não substitui a garantia.
    */
    const hash = await this.deps.hash(ownerToken);
    const peerId = this.deps.newPeerId('h');
    const donoPrevio = await this.donoAtual();
    if (donoPrevio !== null && !this.deps.equals(donoPrevio, hash)) {
      return this.fail(socket, (await this.falhaDentroDoTeto(ip)) ? 'SLUG_TAKEN' : 'RATE_LIMITED');
    }

    /*
      Slug LIVRE: aqui mora o squatting. Limite por IP ENTRE canais (o objeto
      é por slug e não enxerga o resto): rajada por minuto e acúmulo por hora.
      O dono que reconecta (`donoPrevio` bate) não passa por aqui.
    */
    if (donoPrevio === null) {
      const { hostLimit, hostWindowMs, slugsNovosPorHoraLimit, slugsNovosJanelaMs } = this.deps.limits;
      const livre = (await this.gate(ip, 'host', hostLimit, hostWindowMs)) &&
        (await this.gate(ip, 'host-h', slugsNovosPorHoraLimit, slugsNovosJanelaMs));
      if (!livre) return this.fail(socket, 'RATE_LIMITED');
      if (!this.ctx.getWebSockets().includes(socket)) return;
    }

    /**
     * As credenciais são buscadas ANTES de assumir o canal, e o motivo é a
     * ordem das mensagens.
     *
     * `iceServersFor` é um `fetch` real para a API de TURN — dezenas a
     * centenas de milissegundos em que o runtime deixa outra requisição
     * entrar. Quando esse `await` ficava DEPOIS do attachment, um espectador
     * que chegasse na janela era roteado para um host que ainda não tinha
     * recebido `hosting`: ele via `peer-joined` antes de saber que era host,
     * e depois o mesmo `peer-joined` de novo na reapresentação. Duas
     * violações de protocolo que só não quebravam porque se cancelavam.
     */
    const ice = await this.deps.iceServersFor(peerId);
    if (!this.ctx.getWebSockets().includes(socket)) return;

    /**
     * Seção crítica: ler a posse, decidir e gravar sem ceder o loop no meio.
     *
     * Sem ela o `claim` era um `check-then-act` clássico. Duas reivindicações
     * simultâneas de um canal sem dono se intercalavam no `await` do hash, e o
     * resultado era pior que "quem chegou primeiro leva": quem mandou PRIMEIRO
     * recebia `SLUG_TAKEN`, e depois ficava trancado fora do próprio slug pelos
     * cinco minutos da carência de posse.
     */
    const assumido = await this.ctx.blockConcurrencyWhile(async () => {
      const dono = await this.donoAtual();
      if (!this.ctx.getWebSockets().includes(socket)) return null;
      // Existe dono e não é você: o canal é de outra pessoa, com ou sem
      // alguém conectado neste instante.
      if (dono !== null && !this.deps.equals(dono, hash)) return null;

      /**
       * A ORDEM importa: o socket novo assume ANTES de o antigo ser derrubado.
       *
       * Fechar primeiro dispara o `webSocketClose` do antigo enquanto o novo
       * ainda não tem attachment — e o objeto, sem enxergar host algum,
       * concluía que o transmissor tinha ido embora e derrubava todos os
       * espectadores. Quem dava F5 perdia a audiência.
       */
      const anterior = this.host();
      this.gravar(socket, {
        peerId,
        role: 'host',
        ownerHash: hash,
        aprovacao,
        ...(capacidade === undefined ? {} : { capacidade }),
        ...(ip === undefined ? {} : { ip }),
        janelaInicio: Date.now(),
        janelaContagem: 0,
      } satisfies Attachment);
      return { anterior };
    });

    if (!this.ctx.getWebSockets().includes(socket)) return;
    if (assumido === null) return this.fail(socket, 'SLUG_TAKEN');

    // Mesmo dono reconectando (refresh, troca de rede): derruba o antigo.
    // Se voltou com teto menor, ninguém é expulso: só não entra mais.
    if (assumido.anterior !== null) this.esquecer(assumido.anterior.socket);
    assumido.anterior?.socket.close(1000, 'substituido');

    this.send(socket, {
      type: 'hosting',
      peerId,
      iceServers: [...ice.servers],
      relayStatus: ice.relayStatus,
      ...(ice.issuedAt === undefined ? {} : { issuedAt: ice.issuedAt }),
      ...(ice.expiresAt === undefined ? {} : { expiresAt: ice.expiresAt }),
      maxPeers: this.tetoPara(capacidade),
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
      if (viewer.at.ready === false) continue;
      this.send(socket, {
        type: 'peer-joined', peerId: viewer.at.peerId,
        ...(viewer.at.attemptId === undefined ? {} : { attemptId: viewer.at.attemptId }),
        ...this.quemE(viewer.at),
      });
    }
    // Pedidos que esperavam o transmissor voltar continuam de pé.
    // Ou entram de uma vez, se ele voltou com a sala aberta.
    for (const p of this.pedidos()) {
      if (aprovacao) this.send(socket, this.pedidoParaHost(p.at));
      else {
        await this.admitir(
          p.socket, p.at.peerId, p.at.name, p.at.fingerprint, p.at.participantId, p.at.attemptId, null, p.at.ip,
        );
      }
    }
  }

  private async join(
    socket: HibernatableSocket, slug: string, wanted: string,
    participantId?: string, attemptId?: string, name?: string, viewerKey?: string, ip?: string,
  ): Promise<void> {
    // `isBlockedSlug` também aqui: sem ele o Node responde `SLUG_INVALID` e o
    // Worker responde `NOT_HOSTING` para o mesmo pedido, e a diferença deixa
    // quem varre nomes distinguir "bloqueado" de "inexistente" — exatamente o
    // que o comentário abaixo diz querer evitar.
    if (wanted !== slug || !SLUG_RE.test(slug) || isBlockedSlug(slug)) {
      return this.fail(socket, 'SLUG_INVALID');
    }

    const host = this.host();
    // Slug inválido, inexistente e offline devolvem o MESMO erro: quem varre
    // nomes não distingue "não existe" de "existe e está fora do ar".
    if (host === null) return this.fail(socket, 'NOT_HOSTING');

    /*
      S-02: cada entrada acaba numa credencial TURN paga. O orçamento por IP é
      cobrado AQUI, antes de qualquer outro `await`, porque a contagem de
      vagas abaixo e a gravação do attachment não podem ser separadas por uma
      ida ao contador (outra entrada passaria no meio e estouraria o teto).
    */
    if (!(await this.gate(ip, 'watch', this.deps.limits.watchIpLimit, this.deps.limits.watchIpWindowMs))) {
      return this.fail(socket, 'RATE_LIMITED');
    }
    if (!this.ctx.getWebSockets().includes(socket)) return;

    /*
      Sala aberta (ADR 0028): quem tem o link entra direto, como antes da
      ADR 0025. Retomada pelo `participantId`, segredo de alta entropia do
      navegador.
    */
    if (host.at.aprovacao !== true) {
      const impressao = viewerKey === undefined ? undefined : await this.deps.hash(viewerKey);
      if (!this.ctx.getWebSockets().includes(socket)) return;
      if (this.host() === null) return this.fail(socket, 'NOT_HOSTING');
      const anterior = participantId === undefined ? undefined : this.viewers()
        .find((viewer) => viewer.at.participantId === participantId);
      if (anterior === undefined && this.viewers().length >= this.teto()) {
        return this.fail(socket, 'CHANNEL_FULL', this.teto());
      }
      // S-07: um IP não toma o canal inteiro. Só na sala aberta; quem o dono aprova à mão não é cortado.
      if (anterior === undefined && ip !== undefined &&
        this.viewers().filter((v) => v.at.ip === ip).length >= this.deps.limits.viewersPorIp) {
        return this.fail(socket, 'RATE_LIMITED');
      }
      return await this.admitir(
        socket, anterior?.at.peerId ?? this.deps.newPeerId('v'), name, impressao,
        participantId, attemptId, anterior?.socket ?? null, ip,
      );
    }

    // Sala com aprovação: sem apelido e chave não há o que mostrar ao dono (ADR 0025).
    if (name === undefined || viewerKey === undefined) return this.fail(socket, 'BAD_MESSAGE');
    const fingerprint = await this.deps.hash(viewerKey);
    if (!this.ctx.getWebSockets().includes(socket)) return;
    const hostDoPedido = this.host();
    if (hostDoPedido === null) return this.fail(socket, 'NOT_HOSTING');

    /*
      Retomada: o MESMO navegador (chave e participante) cujo socket caiu e
      voltou antes de o objeto notar. Já foi aceito — pedir de novo por uma
      piscada de rede seria punir a pessoa pela rede dela.
    */
    const previous = participantId === undefined ? undefined : this.viewers()
      .find((viewer) => viewer.at.participantId === participantId &&
        typeof viewer.at.fingerprint === 'string' && this.deps.equals(viewer.at.fingerprint, fingerprint));
    if (previous !== undefined) {
      return await this.admitir(
        socket, previous.at.peerId, name, fingerprint, participantId, attemptId, previous.socket, ip,
      );
    }

    if (this.viewers().length >= this.teto()) return this.fail(socket, 'CHANNEL_FULL', this.teto());

    // O mesmo pedido chegando por outro socket substitui o anterior.
    const repetido = participantId === undefined ? undefined : this.pedidos()
      .find((p) => p.at.participantId === participantId &&
        typeof p.at.fingerprint === 'string' && this.deps.equals(p.at.fingerprint, fingerprint));
    if (repetido === undefined && this.pedidos().length >= this.deps.limits.maxPending) {
      return this.fail(socket, 'RATE_LIMITED');
    }
    // S-07: um IP também não enche a fila do dono de pedidos.
    if (repetido === undefined && ip !== undefined &&
      this.pedidos().filter((p) => p.at.ip === ip).length >= this.deps.limits.viewersPorIp) {
      return this.fail(socket, 'RATE_LIMITED');
    }
    const peerId = repetido?.at.peerId ?? this.deps.newPeerId('v');
    if (repetido !== undefined) {
      // Marca antes de fechar: o `webSocketClose` dele não pode cancelar o pedido novo.
      this.gravar(repetido.socket, { ...repetido.at, removido: true } satisfies Attachment);
      this.esquecer(repetido.socket);
      repetido.socket.close(1000, 'substituido');
    }
    // S-20: dois "Maria" diante do dono seriam indistinguíveis; o segundo vira "Maria (2)".
    const ocupados = [...this.viewers(), ...this.pedidos()]
      .filter((p) => p.socket !== repetido?.socket)
      .flatMap((p) => (p.at.name === undefined ? [] : [p.at.name]));
    const pedido: Attachment = {
      peerId,
      role: 'viewer',
      pendente: true,
      ready: false,
      name: apelidoUnico(name, ocupados),
      ...(ip === undefined ? {} : { ip }),
      fingerprint,
      ...(participantId === undefined ? {} : { participantId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      janelaInicio: Date.now(),
      janelaContagem: 0,
    };
    this.gravar(socket, pedido);
    this.send(socket, { type: 'awaiting-approval' });
    this.send(hostDoPedido.socket, this.pedidoParaHost(pedido));
  }

  /** Só o transmissor atual responde a pedido. Pedido sumido é silêncio. */
  private async responder(
    socket: HibernatableSocket, at: Attachment, peerId: string, aceitar: boolean,
  ): Promise<void> {
    if (at.role !== 'host' || this.host()?.socket !== socket) return this.fail(socket, 'BAD_MESSAGE');
    const alvo = this.pedidos().find((p) => p.at.peerId === peerId);
    if (alvo === undefined) return;
    if (!aceitar) {
      this.gravar(alvo.socket, { ...alvo.at, removido: true } satisfies Attachment);
      return this.fail(alvo.socket, 'DENIED');
    }
    // A vaga é conferida de novo: pode ter enchido enquanto esperava.
    if (this.viewers().length >= this.teto()) {
      this.gravar(alvo.socket, { ...alvo.at, removido: true } satisfies Attachment);
      this.send(socket, { type: 'join-cancelled', peerId });
      return this.fail(alvo.socket, 'CHANNEL_FULL', this.teto());
    }
    await this.admitir(
      alvo.socket, peerId, alvo.at.name ?? '?', alvo.at.fingerprint ?? '',
      alvo.at.participantId, alvo.at.attemptId, null, alvo.at.ip,
    );
  }

  /** Da aprovação (ou da retomada) em diante: vaga, credencial, `watching`. */
  private async admitir(
    socket: HibernatableSocket, peerId: string, name: string | undefined, fingerprint: string | undefined,
    participantId: string | undefined, attemptId: string | undefined, anterior: HibernatableSocket | null,
    ip?: string,
  ): Promise<void> {
    this.gravar(socket, {
      peerId,
      role: 'viewer',
      ...(ip === undefined ? {} : { ip }),
      ...(name === undefined ? {} : { name }),
      ...(fingerprint === undefined ? {} : { fingerprint }),
      ...(participantId === undefined ? {} : { participantId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      ready: false,
      janelaInicio: Date.now(),
      janelaContagem: 0,
    } satisfies Attachment);
    if (anterior !== null) this.esquecer(anterior);
    anterior?.close(1000, 'substituido');

    const ice = await this.deps.iceServersFor(peerId);
    const current = this.atual(socket);
    if (!this.ctx.getWebSockets().includes(socket) || current?.peerId !== peerId ||
      current.attemptId !== attemptId) return;
    const currentHost = this.host();
    if (currentHost === null) return this.fail(socket, 'NOT_HOSTING');
    this.gravar(socket, { ...current, ready: true } satisfies Attachment);
    this.send(socket, {
      type: 'watching',
      peerId,
      hostId: currentHost.at.peerId,
      iceServers: [...ice.servers],
      relayStatus: ice.relayStatus,
      ...(ice.issuedAt === undefined ? {} : { issuedAt: ice.issuedAt }),
      ...(ice.expiresAt === undefined ? {} : { expiresAt: ice.expiresAt }),
      viewers: this.viewers().length,
    });
    // O transmissor é quem oferece — ele tem a mídia.
    this.send(currentHost.socket, {
      type: 'peer-joined', peerId,
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(name === undefined ? {} : { name }),
      ...(fingerprint === undefined ? {} : { fingerprint }),
    });
    this.anunciarPlateia();
  }

  /**
   * Só o transmissor atual tira espectadores. Marca antes de fechar: o
   * `webSocketClose` chega depois, e até lá o removido não pode contar vaga
   * nem receber sinal.
   */
  private removeViewers(socket: HibernatableSocket, at: Attachment, peerId: string | undefined): void {
    if (at.role !== 'host' || this.host()?.socket !== socket) return this.fail(socket, 'BAD_MESSAGE');
    const alvo = this.viewers().filter((v) => peerId === undefined || v.at.peerId === peerId);
    for (const viewer of alvo) {
      this.gravar(viewer.socket, { ...viewer.at, removido: true } satisfies Attachment);
      this.send(viewer.socket, { type: 'error', code: 'REMOVED' });
      viewer.socket.close(1008, 'REMOVED');
      if (viewer.at.ready !== false) this.send(socket, { type: 'peer-left', peerId: viewer.at.peerId });
    }
    if (alvo.length > 0) this.anunciarPlateia();
  }

  /**
   * Só o transmissor atual mexe no teto pela banda (ADR 0030). Nunca acima do
   * que a máquina declarou, e sem tirar ninguém: a vaga de quem já está é
   * dele; o número só decide quem AINDA entra.
   */
  private atualizarCapacidade(socket: HibernatableSocket, at: Attachment, valor: number): void {
    if (at.role !== 'host' || this.host()?.socket !== socket) return this.fail(socket, 'BAD_MESSAGE');
    const tetoPelaBanda = Math.min(this.tetoPara(at.capacidade), valor);
    this.gravar(socket, { ...at, tetoPelaBanda } satisfies Attachment);
  }

  private async refreshIce(socket: HibernatableSocket, at: Attachment, requestId: string): Promise<void> {
    /*
      S-02: cada refresh é um POST pago ao TURN. Um socket sozinho emitiu 230.
      Estourou o teto da conexão ou do IP: silêncio — sem emitir e sem fechar.
      O cliente tem timeout e tenta no ciclo seguinte; derrubar um espectador
      por excesso de renovação puniria a vítima de um cliente com defeito.
    */
    const agora = Date.now();
    const reiniciou = at.refreshInicio === undefined ||
      agora - at.refreshInicio >= this.deps.limits.refreshIceWindowMs;
    const n = reiniciou ? 1 : (at.refreshN ?? 0) + 1;
    this.gravar(socket, { ...at, refreshInicio: reiniciou ? agora : at.refreshInicio, refreshN: n } satisfies Attachment);
    if (n > this.deps.limits.refreshIceSocketLimit) return;
    if (!(await this.gate(
      at.ip, 'refresh', this.deps.limits.refreshIceIpLimit, this.deps.limits.refreshIceWindowMs,
    ))) return;
    const ice = await this.deps.iceServersFor(at.peerId);
    if (!this.ctx.getWebSockets().includes(socket)) return;
    const current = this.atual(socket);
    if (current?.peerId !== at.peerId || current.role !== at.role) return;
    if (at.role === 'host' ? this.host()?.socket !== socket :
      !this.viewers().some((viewer) => viewer.socket === socket)) return;
    this.send(socket, {
      type: 'ice-servers', requestId, iceServers: [...ice.servers], relayStatus: ice.relayStatus,
      ...(ice.issuedAt === undefined ? {} : { issuedAt: ice.issuedAt }),
      ...(ice.expiresAt === undefined ? {} : { expiresAt: ice.expiresAt }),
    });
  }

  /**
   * Avisa a plateia do tamanho dela.
   *
   * Só para espectadores: o transmissor já acompanha por
   * `peer-joined`/`peer-left`, que carregam os ids de que ele precisa para
   * negociar mídia.
   */
  private anunciarPlateia(): void {
    const espectadores = this.viewers();
    const count = espectadores.length;
    for (const v of espectadores) {
      if (v.at.ready !== false) this.send(v.socket, { type: 'viewers', count });
    }
  }

  /**
   * O(1): índice por socket, por peerId e o host em cache (ADR 0031).
   * Mesma semântica da varredura que havia aqui — espectador só fala com o
   * host, host endereça por `to`, e removido/pendente/não-pronto não recebe.
   */
  private relay(
    socket: HibernatableSocket, from: Attachment, message: Extract<ClientMessage, { type: 'signal' }>,
    bytes: number,
  ): void {
    if (from.ready === false) return;
    if (from.role === 'viewer') {
      /*
        S-07: o host paga cada byte que um espectador manda. Frame grande
        demais é abuso (SDP legítimo é pequeno); volume demais na janela
        também. Contado no attachment: sobrevive à hibernação.
      */
      if (bytes > this.deps.limits.viewerSignalMaxBytes) return this.fail(socket, 'BAD_MESSAGE');
      const total = (this.atual(socket)?.janelaBytes ?? 0) + bytes;
      if (total > this.deps.limits.viewerSignalBytesPorJanela) return this.fail(socket, 'RATE_LIMITED');
      const atual = this.atual(socket);
      if (atual !== null) this.gravar(socket, { ...atual, janelaBytes: total } satisfies Attachment);
    }
    const indice = this.indice();
    let target: HibernatableSocket | undefined;
    if (from.role === 'host') {
      if (this.socketDoHost !== socket) return;
      const alvo = this.porPeer.get(message.to ?? '');
      const at = alvo === undefined ? undefined : indice.get(alvo);
      if (alvo === undefined || at === undefined) return;
      if (at.role !== 'viewer' || at.removido === true || at.pendente === true || at.ready === false) return;
      target = alvo;
    } else {
      if (from.removido === true || from.pendente === true) return;
      target = this.socketDoHost ?? undefined;
    }
    if (target === undefined) return;

    // `payload` atravessa sem ser lido. R8.
    this.send(target, { type: 'signal', from: from.peerId, payload: message.payload });
  }

  /** Chamado por `webSocketClose` e `webSocketError`. */
  handleClose(socket: HibernatableSocket): void {
    // Antes de qualquer consulta: as checagens abaixo assumem que o socket que sai já não conta.
    this.esquecer(socket);
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

      /**
       * Socket do transmissor que CAIU não derruba a plateia.
       *
       * A mídia é direta entre os dois: o servidor nunca esteve no caminho
       * dela, então não deveria estar no caminho da falha. Derrubar aqui fazia
       * uma piscada de rede do transmissor — ou um deploy nosso — apagar
       * transmissões que continuavam funcionando. Medido: 5 segundos de tela
       * morta, e conexões duplicadas quando o transmissor voltava com um
       * `peerId` novo e era admitido como se fosse outro peer.
       *
       * Quem detecta saída de verdade é o espectador, pela MÍDIA: a trilha
       * remota termina e ele reage na hora. É o sinal certo, porque é o que
       * ele está consumindo.
       *
       * A reapresentação em `claim` só existe por causa disto — enquanto a
       * plateia era derrubada aqui, ela iterava lista vazia.
       */
      if (at.saiuDeProposito !== true) return;

      // Saída anunciada: avisa ANTES de fechar, sem esperar a mídia morrer.
      for (const viewer of this.viewers()) {
        this.send(viewer.socket, { type: 'peer-left', peerId: at.peerId });
        viewer.socket.close(1000, 'host saiu');
      }
      // Quem esperava resposta não vai ter: não há mais transmissão.
      for (const p of this.pedidos()) {
        this.gravar(p.socket, { ...p.at, removido: true } satisfies Attachment);
        this.fail(p.socket, 'NOT_HOSTING');
      }
      return;
    }

    // Removido pelo transmissor: `peer-left` e plateia já foram avisados.
    if (at.removido === true) return;
    if (at.pendente === true) {
      // Desistiu (ou caiu) antes da resposta: some da fila do transmissor.
      const hostAtual = this.host();
      if (hostAtual !== null) this.send(hostAtual.socket, { type: 'join-cancelled', peerId: at.peerId });
      return;
    }
    if (this.viewers().some((viewer) => viewer.at.peerId === at.peerId)) return;
    const host = this.host();
    if (at.ready !== false && host !== null) this.send(host.socket, { type: 'peer-left', peerId: at.peerId });
    // O socket que está saindo já não aparece em `getWebSockets()`.
    this.anunciarPlateia();
  }
}


const codificador = new TextEncoder();

function tamanhoEmBytes(texto: string): number {
  return codificador.encode(texto).byteLength;
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

/**
 * Configuração de ICE que não fecha vira "sem relay", não "sem sinalização".
 *
 * Lançava no construtor do Durable Object, e o custo disso foi uma produção
 * inteira fora do ar: dois secrets de TURN gravados VAZIOS faziam toda
 * conexão responder 500, com o deploy verde e o `check-prod` em dia. No Node a
 * mesma validação falha no boot e alguém vê; no Worker o deploy passa e cada
 * requisição morre em silêncio.
 *
 * O relay é a rota de exceção — NAT simétrico dos dois lados. A sinalização é
 * a porta de entrada de todo mundo. Sem relay, a maioria dos amigos ainda
 * conecta direto; sem sinalização, ninguém. Então: STUN só (o padrão, ou o
 * `STUN_URLS` se ele estiver certo), `relayStatus: 'not-configured'` para os
 * clientes, e os CÓDIGOS do problema no log — nunca os valores.
 */
function iceComFallback(env: Env, relatar: (problemas: readonly string[]) => void): IceSettings {
  const parsed = parseIceSettings(env);
  if ('settings' in parsed) return parsed.settings;
  relatar(parsed.problems);
  const soStun = parseIceSettings({ STUN_URLS: env.STUN_URLS });
  if ('settings' in soStun) return soStun.settings;
  const padrao = parseIceSettings({});
  if ('settings' in padrao) return padrao.settings;
  // O padrão é constante do código: se ele não passa, é bug, não configuração.
  throw new Error('ICE_DEFAULT_INVALID');
}

/**
 * Fala com o `IpLimiter` do IP. Erro de rede ou do objeto = permitido: o freio
 * de abuso não pode ser, ele mesmo, o que derruba a sinalização.
 */
export function makeIpGate(
  namespace: DurableObjectNamespace | undefined,
): ChannelDeps['ipGate'] {
  if (namespace === undefined) return undefined;
  return async (ip, chave, limite, janelaMs) => {
    try {
      const resposta = await namespace.get(namespace.idFromName(ip)).fetch(
        new Request('https://ip-limiter/take', {
          method: 'POST',
          body: JSON.stringify({ chave, limite, janelaMs }),
        }),
      );
      const corpo = (await resposta.json()) as { permitido?: unknown };
      return corpo.permitido !== false;
    } catch {
      return true;
    }
  };
}

/**
 * Abertura de WebSocket por IP, ANTES de acordar o objeto do canal (S-02).
 * Mesmo teto do Node (`openLimit`). Sem IP ou sem contador: passa.
 */
export async function aberturaPermitida(
  gate: ChannelDeps['ipGate'], ip: string | null, limits: Limits,
): Promise<boolean> {
  if (gate === undefined || ip === null || ip === '') return true;
  return await gate(ip, 'open', limits.openLimit, limits.openWindowMs);
}

export function makeChannelDeps(
  env: Env,
  crypto: WebCryptoLike,
  relatar: (problemas: readonly string[]) => void = (problemas) =>
    console.error(`ICE_CONFIG_INVALID: ${problemas.join(',')} — sinalização segue sem relay`),
): ChannelDeps {
  // Pode baixar o teto do produto (ADR 0029), nunca passar dele.
  const parsedMax = Number(env.MAX_PEERS ?? DEFAULT_LIMITS.maxPeers);
  if (!Number.isInteger(parsedMax) || parsedMax < 1 || parsedMax > P2P_LIMITS.maxViewers) {
    throw new Error('MAX_PEERS_INVALID');
  }
  const porIp = Number(env.MAX_VIEWERS_PER_IP ?? DEFAULT_LIMITS.viewersPorIp);
  if (!Number.isInteger(porIp) || porIp < 1 || porIp > P2P_LIMITS.maxViewers) {
    throw new Error('MAX_VIEWERS_PER_IP_INVALID');
  }
  const settings = iceComFallback(env, relatar);
  const cloudflare = makeCloudflareProvider(settings);

  const encoder = new TextEncoder();

  const ipGate = makeIpGate(env.IP_LIMITER);

  return {
    limits: {
      ...DEFAULT_LIMITS,
      maxPeers: parsedMax,
      viewersPorIp: porIp,
    },
    ...(ipGate === undefined ? {} : { ipGate }),

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
      const primary = settings.provider === 'coturn'
        ? { servers: [{ urls: [...settings.stunUrls] }], relayStatus: 'not-configured' } as IceProvisionResult
        : await cloudflare();
      if (primary.failureCode !== undefined) console.warn(primary.failureCode);
      if (primary.relayStatus === 'available') return primary;
      if (settings.turnSecret === undefined || settings.turnUrls.length === 0) return primary;

      // `use-auth-secret` do coturn: usuário e senha derivados, com validade
      // curta. Credencial estática num front público é um relay aberto para a
      // internet inteira, rodando na sua cota.
      const ttl = settings.ttlSeconds;
      const expiry = Math.floor(Date.now() / 1000) + ttl;
      const username = `${expiry}:${peerId}`;

      try {
        const key = await crypto.subtle.importKey(
          'raw',
          encoder.encode(settings.turnSecret),
          { name: 'HMAC', hash: 'SHA-1' },
          false,
          ['sign'],
        );
        const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(username));

        return {
          servers: [...primary.servers, {
            urls: [...settings.turnUrls],
            username,
            credential: toBase64(new Uint8Array(signature)),
          }],
          relayStatus: 'available',
          expiresAt: expiry * 1000,
          ...(primary.failureCode === undefined ? {} : { failureCode: primary.failureCode }),
        };
      } catch {
        console.warn('TURN_UPSTREAM_FAILED');
        return { servers: primary.servers, relayStatus: 'unavailable', failureCode: 'TURN_UPSTREAM_FAILED' };
      }
    },
  };
}
