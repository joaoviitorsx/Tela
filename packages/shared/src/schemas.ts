import { z } from 'zod';

/* ────────────────────────── primitivos ────────────────────────── */

/** 3–25 chars, minúsculas/dígitos/hífen, não começa nem termina com hífen. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,23}[a-z0-9]$/;

export const SlugSchema = z.string().regex(SLUG_RE);

/** 32 bytes aleatórios em base64url = 43 chars. É a credencial, não há senha. */
export const OwnerTokenSchema = z.string().min(43).max(64);

export const PresetIdSchema = z.enum(['p1080p60', 'p720p60', 'p720p60eco', 'p720p30']);

export const TransportKindSchema = z.enum(['sfu', 'p2p']);
export type TransportKind = z.infer<typeof TransportKindSchema>;

export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServerSchema>;

/* ────────────────────────── registros (Redis) ────────────────────────── */

export const SlugRecordSchema = z.object({
  ownerHash: z.string().length(64), // sha256 hex
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
});
export type SlugRecord = z.infer<typeof SlugRecordSchema>;

export const LiveRecordSchema = z.object({
  room: z.string(),
  startedAt: z.number().int(),
  publisherId: z.string(),
});
export type LiveRecord = z.infer<typeof LiveRecordSchema>;

/* ────────────────────────── erros ────────────────────────── */

export const AppErrorSchema = z.enum([
  'SLUG_INVALID',
  'SLUG_RESERVED',
  'SLUG_TAKEN',
  'SLUG_UNKNOWN',
  'OWNER_INVALID',
  'NOT_LIVE',
  'RATE_LIMITED',
  'VIEWER_LIMIT',
  'UPSTREAM_UNAVAILABLE',
]);
export type AppErrorCode = z.infer<typeof AppErrorSchema>;

export const ErrorResponseSchema = z.object({
  error: AppErrorSchema,
  message: z.string().optional(),
  suggestions: z.array(SlugSchema).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/* ────────────────────────── POST /claim ────────────────────────── */

export const ClaimRequestSchema = z.object({
  slug: z.string(),
  ownerToken: OwnerTokenSchema,
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

export const ClaimResponseSchema = z.object({
  slug: SlugSchema,
  shareUrl: z.string().url(),
});
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

/* ──────────────────── conexão de mídia (união discriminada) ──────────────────── */

/**
 * O que o cliente precisa para abrir o transporte de mídia.
 *
 * `sfu`: fala com o LiveKit por WebSocket, mídia sobe uma vez e o servidor replica.
 * `p2p`: fala com o hub de sinalização da própria API, mídia vai direto de
 *        browser para browser — o transmissor É o servidor.
 *
 * core/ escolhe o adapter por este campo. Nenhuma outra parte do código
 * precisa saber qual transporte está em uso.
 */
export const SfuConnectionSchema = z.object({
  transport: z.literal('sfu'),
  token: z.string(),
  wsUrl: z.string(),
  room: z.string(),
});

export const P2pConnectionSchema = z.object({
  transport: z.literal('p2p'),
  ticket: z.string(),
  signalUrl: z.string(),
  room: z.string(),
  iceServers: z.array(IceServerSchema),
  maxViewers: z.number().int().min(1),
});

export const ConnectionSchema = z.discriminatedUnion('transport', [
  SfuConnectionSchema,
  P2pConnectionSchema,
]);
export type Connection = z.infer<typeof ConnectionSchema>;

/* ────────────────────────── POST /broadcast/* ────────────────────────── */

/**
 * O slug viaja no CORPO junto do ownerToken, não na URL.
 *
 * Desvio consciente da §6 da documentação técnica, que descreve
 * `POST /broadcast/start { ownerToken }` sem slug: recuperar o slug só a
 * partir do token exigiria um índice reverso ownerHash → slug, uma segunda
 * fonte de verdade que pode divergir da primeira. O cliente sempre sabe o
 * próprio slug (está no localStorage ao lado do token), então mandá-lo é de
 * graça. Registrado em docs/adr/0003.
 */
export const OwnerRequestSchema = z.object({
  ownerToken: OwnerTokenSchema,
  slug: z.string(),
});
export type OwnerRequest = z.infer<typeof OwnerRequestSchema>;

export const StartBroadcastResponseSchema = z.object({
  connection: ConnectionSchema,
  shareUrl: z.string().url(),
  slug: SlugSchema,
});
export type StartBroadcastResponse = z.infer<typeof StartBroadcastResponseSchema>;

export const PingResponseSchema = z.object({
  ok: z.literal(true),
  viewers: z.number().int().min(0),
});
export type PingResponse = z.infer<typeof PingResponseSchema>;

export const StopResponseSchema = z.object({ ok: z.literal(true) });
export type StopResponse = z.infer<typeof StopResponseSchema>;

/* ────────────────────────── GET /live/:slug ────────────────────────── */

export const LiveStatusSchema = z.union([
  z.object({ live: z.literal(false) }),
  z.object({
    live: z.literal(true),
    startedAt: z.number().int(),
    viewers: z.number().int().min(0),
  }),
]);
export type LiveStatus = z.infer<typeof LiveStatusSchema>;

/* ────────────────────────── POST /join/:slug ────────────────────────── */

export const JoinResponseSchema = z.object({
  connection: ConnectionSchema,
  identity: z.string(),
});
export type JoinResponse = z.infer<typeof JoinResponseSchema>;

/* ────────────────────────── GET /health ────────────────────────── */

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  transport: TransportKindSchema,
  store: z.boolean(),
  gateway: z.boolean(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
