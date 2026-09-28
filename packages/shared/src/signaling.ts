import { z } from 'zod';

/**
 * Protocolo de sinalização do mesh.
 *
 * O servidor que fala este protocolo NÃO vê mídia — ele repassa `payload`
 * opaco entre pares e nada mais. Kilobytes por sessão, contra gigabytes por
 * hora num SFU. É essa assimetria que torna a arquitetura de custo zero
 * possível (ADR 0005).
 *
 * REGRA R8: `payload` é opaco. O servidor não parseia SDP, não inspeciona
 * ICE, não guarda histórico. Se você se pegar dando um `z.object({ sdp })`
 * nele, parou de ser mesh — e o servidor virou parte do caminho da mídia.
 * Por isso o tipo aqui é `z.unknown()` e não algo mais específico: a
 * imprecisão é a especificação.
 *
 * Topologia: estrela com o transmissor no centro. Espectador só fala com o
 * transmissor, nunca com outro espectador.
 */

export const PeerIdSchema = z.string().min(1).max(64);

/**
 * Versão do protocolo (TELA-018). Cliente sem o campo é da versão 1, que não
 * conhece convite — e é recusado com `BAD_MESSAGE`, um código que ele entende.
 * Nunca se converte uma sala privada em aberta para aceitar cliente antigo.
 *
 * A 3 trouxe a aprovação manual (ADR 0025): quem fala 2 entraria sem pedir, e
 * por isso recebe `PROTOCOL_MISMATCH` — "recarregue" — em vez de passar.
 */
export const PROTOCOL_VERSION = 3;

/**
 * Segredo de convite: pelo menos 128 bits em base64url (16 bytes = 22 chars).
 *
 * Independente do `ownerToken`: o convite vai no link do espectador, o token
 * do dono nunca. O servidor guarda só o hash, e o compara antes de reservar
 * vaga ou emitir credencial TURN.
 */
export const InviteSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
export type PeerId = z.infer<typeof PeerIdSchema>;

/**
 * Chave do navegador de quem assiste (ADR 0025): mesmo formato do convite.
 *
 * É o que faz "já aprovei esta pessoa" valer na volta. O transmissor nunca vê a
 * chave, só o sha256 dela (`fingerprint`), calculado PELO SERVIDOR — um cliente
 * que mandasse o próprio fingerprint poderia se passar por quem já foi aceito.
 */
export const ViewerKeySchema = InviteSchema;

/**
 * Como o transmissor reconhece quem pede para entrar. Não é conta (R6): não
 * tem senha, não é único, e o servidor só o segura enquanto a conexão existe.
 * Sem caractere de controle, para não quebrar a linha de quem lê.
 */
export const APELIDO_MAX = 24;
export const ApelidoSchema = z
  .string()
  .trim()
  .min(1)
  .max(APELIDO_MAX)
  .regex(/^[^\p{C}]+$/u);

export const SignalingErrorCodeSchema = z.enum([
  'SLUG_TAKEN', // já existe transmissão nesse slug, de outro dono
  'SLUG_INVALID',
  'NOT_HOSTING', // ninguém transmitindo nesse slug
  'CHANNEL_FULL', // MAX_PEERS atingido
  'RATE_LIMITED',
  'OWNER_INVALID',
  'BAD_MESSAGE',
  /** Convite ausente, errado ou renovado. Só é dito quando há transmissão. */
  'INVITE_INVALID',
  /** Cliente e servidor falam versões diferentes: recarregar resolve. */
  'PROTOCOL_MISMATCH',
  /** O transmissor tirou este espectador. Não tentar de novo sozinho. */
  'REMOVED',
  /** O transmissor recusou o pedido. Pedir de novo é escolha da pessoa. */
  'DENIED',
  'HELLO_TIMEOUT', // conectou e não se apresentou
  /**
   * O canal nem chegou a abrir.
   *
   * Nunca vem do servidor — é o cliente reportando que não conseguiu falar
   * com ele. Existe porque tratar isso como `NOT_HOSTING` transformava todo
   * problema de rede, proxy ou bloqueio de navegador em "ninguém está
   * transmitindo", e o usuário ficava esperando por uma transmissão que
   * estava no ar o tempo todo.
   */
  'SIGNAL_UNREACHABLE',
]);
export type SignalingErrorCode = z.infer<typeof SignalingErrorCodeSchema>;

export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServerConfig = z.infer<typeof IceServerSchema>;
export const RelayStatusSchema = z.enum(['available', 'not-configured', 'unavailable']);
export type RelayStatus = z.infer<typeof RelayStatusSchema>;

/* ───────────────────── cliente → servidor ───────────────────── */

export const ClientMessageSchema = z.discriminatedUnion('type', [
  /** Reivindica o canal. O ownerToken é comparado, nunca logado nem devolvido. */
  z.object({
    type: z.literal('host'),
    /** Ausente = cliente da versão 1. */
    protocol: z.number().int().min(1).max(1000).optional(),
    slug: z.string().min(1).max(64),
    ownerToken: z.string().min(43).max(256),
    /** Obrigatório a partir da versão 2; a validação é do servidor, não do schema. */
    invite: InviteSchema.optional(),
  }),
  z.object({
    type: z.literal('watch'), slug: z.string().min(1).max(64),
    protocol: z.number().int().min(1).max(1000).optional(),
    invite: InviteSchema.optional(),
    /** Identidade efêmera de alta entropia; quem a conhece pode retomar a vaga. */
    participantId: z.string().min(16).max(128).optional(),
    /** Nova PC = nova tentativa; reconexão apenas do socket preserva este ID. */
    attemptId: z.string().min(16).max(128).optional(),
    /** Obrigatórios a partir da versão 3 (ADR 0025); quem exige é o servidor. */
    name: ApelidoSchema.optional(),
    viewerKey: ViewerKeySchema.optional(),
  }),
  /**
   * Só o transmissor: responde a um `join-request`. `admit` segue a entrada
   * normal (vaga, credencial, `watching`); `deny` fecha com `DENIED`.
   */
  z.object({ type: z.literal('admit'), peerId: PeerIdSchema }),
  z.object({ type: z.literal('deny'), peerId: PeerIdSchema }),
  z.object({ type: z.literal('refresh-ice'), requestId: z.string().min(1).max(64) }),
  /**
   * Só o transmissor: troca o convite. Quem já está assistindo fica; só
   * entradas NOVAS passam a exigir o convite novo (decisão do dono do produto).
   */
  z.object({ type: z.literal('set-invite'), invite: InviteSchema }),
  /**
   * Só o transmissor: tira um espectador, ou todos sem `peerId`. Ação separada
   * de renovar. Convite é token compartilhado: quem sai pode voltar com o
   * mesmo link até ele ser renovado — não é banimento.
   */
  z.object({ type: z.literal('remove-viewers'), peerId: PeerIdSchema.optional() }),
  /** `to` opcional: espectador só tem um destino possível, o transmissor. */
  z.object({
    type: z.literal('signal'),
    to: PeerIdSchema.optional(),
    payload: z.unknown(),
  }),
  z.object({ type: z.literal('leave') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* ───────────────────── servidor → cliente ───────────────────── */

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hosting'),
    peerId: PeerIdSchema,
    /**
     * Credencial de TURN efêmera. Nunca vai no bundle do front: quem a
     * entrega é o servidor, no momento em que ela é necessária, com validade
     * curta. Credencial de TURN em bundle estático é credencial pública.
     */
    iceServers: z.array(IceServerSchema),
    /** Estado público; a causa detalhada permanece apenas no servidor. */
    relayStatus: RelayStatusSchema.optional(),
    issuedAt: z.number().int().nonnegative().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
    maxPeers: z.number().int().min(1),
  }),
  z.object({
    type: z.literal('watching'),
    peerId: PeerIdSchema,
    hostId: PeerIdSchema,
    iceServers: z.array(IceServerSchema),
    relayStatus: RelayStatusSchema.optional(),
    issuedAt: z.number().int().nonnegative().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
    /** Valor inicial; depois disso, mensagens `viewers` mantêm atualizado. */
    viewers: z.number().int().min(1),
  }),
  /**
   * Quantos estão assistindo AGORA, mandado a quem assiste.
   *
   * Contagem e não lista: o espectador quer saber se está sozinho ou se a
   * galera chegou, e não tem por que receber o identificador dos outros. O
   * transmissor continua recebendo `peer-joined`/`peer-left`, porque ele
   * precisa dos ids para negociar mídia com cada um.
   */
  z.object({ type: z.literal('viewers'), count: z.number().int().min(0) }),
  z.object({
    type: z.literal('ice-servers'), requestId: z.string().min(1).max(64),
    iceServers: z.array(IceServerSchema), relayStatus: RelayStatusSchema,
    issuedAt: z.number().int().nonnegative().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
  }),
  /** Resposta a `set-invite`: o convite novo já vale para entradas novas. */
  z.object({ type: z.literal('invite-set') }),
  /**
   * Para o espectador: convite aceito, pedido na mão do transmissor. Nada de
   * vaga nem credencial TURN ainda — isso só depois do `admit` (ADR 0025).
   */
  z.object({ type: z.literal('awaiting-approval') }),
  /**
   * Para o transmissor: alguém com o convite pede para entrar. `peerId` é o que
   * ele terá ao entrar; `fingerprint` é o sha256 da chave do navegador dele.
   */
  z.object({
    type: z.literal('join-request'),
    peerId: PeerIdSchema,
    name: ApelidoSchema,
    fingerprint: z.string().min(16).max(128),
  }),
  /** Para o transmissor: o pedido sumiu (a pessoa desistiu ou caiu). */
  z.object({ type: z.literal('join-cancelled'), peerId: PeerIdSchema }),
  z.object({
    type: z.literal('peer-joined'),
    peerId: PeerIdSchema,
    attemptId: z.string().optional(),
    /** Quem é, para a lista do transmissor sobreviver a um F5 dele. */
    name: ApelidoSchema.optional(),
    fingerprint: z.string().min(16).max(128).optional(),
  }),
  z.object({ type: z.literal('peer-left'), peerId: PeerIdSchema }),
  z.object({ type: z.literal('signal'), from: PeerIdSchema, payload: z.unknown() }),
  z.object({ type: z.literal('error'), code: SignalingErrorCodeSchema }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/* ───────────────────── limites do protocolo ───────────────────── */

/** Cliente tem este tempo para mandar `host` ou `watch` antes do socket cair. */
export const HELLO_TIMEOUT_MS = 5_000;

/**
 * Keepalive. O ping parte do SERVIDOR — o browser responde pong sozinho, sem
 * que a página precise fazer nada. JavaScript não consegue enviar frame de
 * ping, então a direção oposta exigiria uma mensagem de aplicação inútil.
 */
export const SIGNAL_PING_INTERVAL_MS = 30_000;

/** Frame acima disso derruba a conexão. SDP grande é legítimo; megabyte não é. */
export const MAX_FRAME_BYTES = 64 * 1024;
