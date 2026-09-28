import {
  type ClientMessage,
  ClientMessageSchema,
  HELLO_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  SLUG_RE,
  type ServerMessage,
  type SignalingErrorCode,
  isBlockedSlug,
} from '@tela/shared';
import { DEFAULT_LIMITS, type Limits } from './limits.js';
import { parseIceSettings } from './ice-settings.js';
import { makeCloudflareProvider, type IceProvisionResult } from './ice-provision.js';

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
  /** Só no socket do host: sha256 do ownerToken de quem reivindicou. */
  readonly ownerHash?: string;
  /**
   * Só no socket do host: sha256 do convite vigente (TELA-018). Viaja com o
   * host pelo mesmo motivo do `ownerHash`: sobreviver à hibernação. Sem host
   * não há o que assistir, então não precisa de storage.
   */
  readonly inviteHash?: string;
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
};

export type Env = {
  CHANNELS: DurableObjectNamespace;
  /** Front estático servido pelo mesmo Worker. Ver `wrangler.toml`. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  MAX_PEERS?: string;
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
};

/**
 * Socket que ainda não se apresentou. Vive no attachment pelo mesmo motivo de
 * tudo aqui: timer de instância não sobrevive à hibernação, e um socket que
 * abre e nunca fala seguraria recurso para sempre.
 */
type PreAttachment = {
  /** Quando abriu. O alarme derruba quem passar do prazo sem saudação. */
  readonly aguardandoDesde?: number;
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
const CHAVE_CLAIMS = 'claims';

type JanelaClaims = { readonly inicio: number; readonly n: number };

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
    return this.peers().filter((p) => p.at.role === 'viewer' && p.at.removido !== true);
  }

  /** Versão do cliente: sem o campo é v1, recusado com código que ele entende. */
  private versaoRecusada(protocol: number | undefined): SignalingErrorCode | null {
    if (protocol === undefined) return 'BAD_MESSAGE';
    return protocol === PROTOCOL_VERSION ? null : 'PROTOCOL_MISMATCH';
  }

  accept(socket: HibernatableSocket): void {
    this.ctx.acceptWebSocket(socket);
    socket.serializeAttachment({ aguardandoDesde: Date.now() } satisfies PreAttachment);
    void this.agendarExpiracao(Date.now() + HELLO_TIMEOUT_MS);
  }

  private preAttachmentOf(socket: HibernatableSocket): PreAttachment | null {
    if (this.attachmentOf(socket) !== null) return null;
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
    const at = this.attachmentOf(socket);

    /*
      Uma saudação por socket, também durante o `await`. Sem isto, três
      `host` seguidos no mesmo socket rodavam três `claim` em paralelo — três
      chamadas pagas à API de TURN antes de qualquer um terminar.
    */
    if ((message.type === 'host' || message.type === 'watch') && at === null) {
      if (this.preAttachmentOf(socket)?.apresentando === true) return this.fail(socket, 'BAD_MESSAGE');
      socket.serializeAttachment({ apresentando: true } satisfies PreAttachment);
    }

    switch (message.type) {
      case 'host': {
        if (at !== null) return;
        const versao = this.versaoRecusada(message.protocol);
        if (versao !== null) return this.fail(socket, versao);
        // Sala sem convite não existe na v2: nunca abrir por omissão.
        if (message.invite === undefined) return this.fail(socket, 'BAD_MESSAGE');
        return await this.claim(socket, slug, message.slug, message.ownerToken, message.invite);
      }
      case 'watch': {
        if (at !== null) return;
        const versao = this.versaoRecusada(message.protocol);
        if (versao !== null) return this.fail(socket, versao);
        return await this.join(
          socket, slug, message.slug, message.invite, message.participantId, message.attemptId,
        );
      }
      case 'set-invite':
        if (at === null) return this.fail(socket, 'BAD_MESSAGE');
        return await this.setInvite(socket, at, message.invite);
      case 'remove-viewers':
        if (at === null) return this.fail(socket, 'BAD_MESSAGE');
        return this.removeViewers(socket, at, message.peerId);
      case 'refresh-ice':
        if (at === null || at.ready === false) return this.fail(socket, 'BAD_MESSAGE');
        return await this.refreshIce(socket, at, message.requestId);
      case 'signal':
        if (at === null) return this.fail(socket, 'BAD_MESSAGE');
        return this.relay(socket, at, message);
      case 'leave':
        // Marca ANTES de fechar: separa "eu parei" de "meu socket caiu".
        if (at !== null) socket.serializeAttachment({ ...at, saiuDeProposito: true });
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

  /**
   * Janela deslizante simples de reivindicações deste canal.
   *
   * Uma linha só no storage, sobrescrita — não acumula. Se o storage não
   * existir (driver de teste antigo), deixa passar: recusar tudo por falta de
   * armazenamento seria pior que não limitar.
   */
  private async dentroDoTetoDeClaims(): Promise<boolean> {
    const agora = Date.now();
    const guardado = await this.ctx.storage?.get<JanelaClaims>(CHAVE_CLAIMS);
    const janela =
      guardado === undefined || agora - guardado.inicio >= this.deps.limits.hostWindowMs
        ? { inicio: agora, n: 0 }
        : guardado;

    if (janela.n >= this.deps.limits.hostLimit) return false;
    await this.ctx.storage?.put(CHAVE_CLAIMS, { inicio: janela.inicio, n: janela.n + 1 });
    return true;
  }

  private async claim(
    socket: HibernatableSocket,
    slug: string,
    claimed: string,
    ownerToken: string,
    invite: string,
  ): Promise<void> {
    // O slug do Durable Object vence: ele veio da URL e determinou qual
    // instância atendeu. Divergir significa cliente confuso ou malicioso.
    // A blocklist vale no SERVIDOR, não só no formulário: pelo WebSocket cru
    // qualquer um pediria `api` ou `admin`.
    if (claimed !== slug || !SLUG_RE.test(slug) || isBlockedSlug(slug)) {
      return this.fail(socket, 'SLUG_INVALID');
    }

    /**
     * Teto de reivindicações, ANTES do hash.
     *
     * O Worker não tinha nenhum — 200 tentativas seguidas, 200 aceitas —
     * enquanto o Node limita a 20/min. Sem isto, `host` + desconectar tranca
     * qualquer slug pelos cinco minutos da carência de posse, de graça e
     * repetível.
     *
     * A contagem é POR CANAL, não por IP: dentro do Durable Object não existe
     * o IP do cliente, e o objeto já é por slug. Isso barra a repetição contra
     * UM slug — que é o que amplificava a corrida do `claim`. Ocupação em massa
     * de slugs diferentes precisaria de um limitador global, e continua aberta.
     *
     * Fica antes do `hash` de propósito: rejeitar tem que ser mais barato que
     * atacar.
     */
    if (!(await this.dentroDoTetoDeClaims())) {
      return this.fail(socket, 'RATE_LIMITED');
    }

    const hash = await this.deps.hash(ownerToken);
    const inviteHash = await this.deps.hash(invite);
    const peerId = this.deps.newPeerId('h');

    /*
      Dono errado sai ANTES da emissão TURN (§9.2: não chamar a API paga antes
      de uma autorização viável). A seção crítica abaixo confere de novo — isto
      só evita o gasto no caso óbvio, não substitui a garantia.
    */
    const donoPrevio = await this.donoAtual();
    if (donoPrevio !== null && !this.deps.equals(donoPrevio, hash)) {
      return this.fail(socket, 'SLUG_TAKEN');
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
      socket.serializeAttachment({
        peerId,
        role: 'host',
        ownerHash: hash,
        inviteHash,
        janelaInicio: Date.now(),
        janelaContagem: 0,
      } satisfies Attachment);
      return { anterior };
    });

    if (!this.ctx.getWebSockets().includes(socket)) return;
    if (assumido === null) return this.fail(socket, 'SLUG_TAKEN');

    // Mesmo dono reconectando (refresh, troca de rede): derruba o antigo.
    assumido.anterior?.socket.close(1000, 'substituido');

    this.send(socket, {
      type: 'hosting',
      peerId,
      iceServers: [...ice.servers],
      relayStatus: ice.relayStatus,
      ...(ice.issuedAt === undefined ? {} : { issuedAt: ice.issuedAt }),
      ...(ice.expiresAt === undefined ? {} : { expiresAt: ice.expiresAt }),
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
      if (viewer.at.ready === false) continue;
      this.send(socket, {
        type: 'peer-joined', peerId: viewer.at.peerId,
        ...(viewer.at.attemptId === undefined ? {} : { attemptId: viewer.at.attemptId }),
      });
    }
  }

  private async join(
    socket: HibernatableSocket, slug: string, wanted: string, invite: string | undefined,
    participantId?: string, attemptId?: string,
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

    /**
     * Convite ANTES de vaga e de credencial TURN (TELA-018, §9.1). Só é dito
     * quando há transmissão, como no Node.
     */
    const inviteHash = invite === undefined ? null : await this.deps.hash(invite);
    if (!this.ctx.getWebSockets().includes(socket)) return;
    const hostAgora = this.host();
    if (hostAgora === null) return this.fail(socket, 'NOT_HOSTING');
    if (inviteHash === null || typeof hostAgora.at.inviteHash !== 'string' ||
      !this.deps.equals(hostAgora.at.inviteHash, inviteHash)) {
      return this.fail(socket, 'INVITE_INVALID');
    }

    const previous = participantId === undefined ? undefined : this.viewers()
      .find((viewer) => viewer.at.participantId === participantId);
    if (previous === undefined && this.viewers().length >= this.deps.limits.maxPeers) {
      return this.fail(socket, 'CHANNEL_FULL');
    }

    const peerId = previous?.at.peerId ?? this.deps.newPeerId('v');
    socket.serializeAttachment({
      peerId,
      role: 'viewer',
      ...(participantId === undefined ? {} : { participantId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      ready: false,
      janelaInicio: Date.now(),
      janelaContagem: 0,
    } satisfies Attachment);
    previous?.socket.close(1000, 'substituido');

    const ice = await this.deps.iceServersFor(peerId);
    const current = this.attachmentOf(socket);
    if (!this.ctx.getWebSockets().includes(socket) || current?.peerId !== peerId ||
      current.attemptId !== attemptId) return;
    const currentHost = this.host();
    if (currentHost === null) return this.fail(socket, 'NOT_HOSTING');
    socket.serializeAttachment({ ...current, ready: true } satisfies Attachment);
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
    });
    this.anunciarPlateia();
  }

  /** Só o transmissor atual troca o convite. Quem já está dentro fica. */
  private async setInvite(socket: HibernatableSocket, at: Attachment, invite: string): Promise<void> {
    if (at.role !== 'host' || this.host()?.socket !== socket) return this.fail(socket, 'BAD_MESSAGE');
    const inviteHash = await this.deps.hash(invite);
    if (!this.ctx.getWebSockets().includes(socket)) return;
    const atual = this.attachmentOf(socket);
    if (atual === null || this.host()?.socket !== socket) return;
    socket.serializeAttachment({ ...atual, inviteHash } satisfies Attachment);
    this.send(socket, { type: 'invite-set' });
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
      viewer.socket.serializeAttachment({ ...viewer.at, removido: true } satisfies Attachment);
      this.send(viewer.socket, { type: 'error', code: 'REMOVED' });
      viewer.socket.close(1008, 'REMOVED');
      if (viewer.at.ready !== false) this.send(socket, { type: 'peer-left', peerId: viewer.at.peerId });
    }
    if (alvo.length > 0) this.anunciarPlateia();
  }

  private async refreshIce(socket: HibernatableSocket, at: Attachment, requestId: string): Promise<void> {
    const ice = await this.deps.iceServersFor(at.peerId);
    if (!this.ctx.getWebSockets().includes(socket)) return;
    const current = this.attachmentOf(socket);
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

  private relay(socket: HibernatableSocket, from: Attachment, message: Extract<ClientMessage, { type: 'signal' }>): void {
    if (from.ready === false) return;
    if (from.role === 'host' ? this.host()?.socket !== socket :
      !this.viewers().some((viewer) => viewer.socket === socket)) return;
    // Espectador só fala com o transmissor; transmissor endereça por `to`.
    const target =
      from.role === 'viewer'
        ? this.host()
        : (this.viewers().find((v) => v.at.peerId === message.to && v.at.ready !== false) ?? null);
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
      return;
    }

    // Removido pelo transmissor: `peer-left` e plateia já foram avisados.
    if (at.removido === true) return;
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

export function makeChannelDeps(env: Env, crypto: WebCryptoLike): ChannelDeps {
  const parsedMax = Number(env.MAX_PEERS ?? DEFAULT_LIMITS.maxPeers);
  if (!Number.isInteger(parsedMax) || parsedMax < 1 || parsedMax > 8) throw new Error('MAX_PEERS_INVALID');
  const parsedIce = parseIceSettings(env);
  if ('problems' in parsedIce) throw new Error(`ICE_CONFIG_INVALID: ${parsedIce.problems.join(',')}`);
  const settings = parsedIce.settings;
  const cloudflare = makeCloudflareProvider(settings);

  const encoder = new TextEncoder();

  return {
    limits: {
      ...DEFAULT_LIMITS,
      maxPeers: parsedMax,
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
