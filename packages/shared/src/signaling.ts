import { z } from 'zod';

/**
 * Protocolo de sinalização do modo P2P.
 *
 * O servidor aqui NÃO vê mídia. Ele só empurra SDP e ICE entre o transmissor
 * e cada espectador — alguns kilobytes por sessão. É o componente que sobra
 * quando você tira o SFU, e é pequeno o bastante para rodar no Raspberry Pi
 * da sala. A mídia vai direto de browser para browser.
 *
 * Topologia: estrela com o transmissor no centro. Espectador só fala com o
 * transmissor, nunca com outro espectador — sem malha entre espectadores,
 * sem relay em cascata (ver ADR 0002 para por que isso foi rejeitado).
 */

export const PeerIdSchema = z.string().min(1).max(64);

const SdpSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().max(64_000),
});

const IceCandidateSchema = z.object({
  candidate: z.string().max(4_000),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});
export type IceCandidateInit = z.infer<typeof IceCandidateSchema>;

/* ───────────────────── cliente → servidor ───────────────────── */

export const ClientMessageSchema = z.discriminatedUnion('t', [
  /** Primeiro frame obrigatório. O ticket vai no corpo, nunca na URL —
   *  query string vaza para log de proxy. */
  z.object({ t: z.literal('hello'), ticket: z.string().min(1).max(4_000) }),
  z.object({ t: z.literal('describe'), to: PeerIdSchema.optional(), sdp: SdpSchema }),
  z.object({ t: z.literal('ice'), to: PeerIdSchema.optional(), candidate: IceCandidateSchema }),
  z.object({ t: z.literal('bye'), to: PeerIdSchema.optional() }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* ───────────────────── servidor → cliente ───────────────────── */

export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('ready'),
    role: z.enum(['publisher', 'viewer']),
    room: z.string(),
    self: PeerIdSchema,
    peers: z.array(PeerIdSchema),
  }),
  z.object({ t: z.literal('peer-joined'), peer: PeerIdSchema }),
  z.object({ t: z.literal('peer-left'), peer: PeerIdSchema }),
  z.object({ t: z.literal('describe'), from: PeerIdSchema, sdp: SdpSchema }),
  z.object({ t: z.literal('ice'), from: PeerIdSchema, candidate: IceCandidateSchema }),
  z.object({ t: z.literal('pong') }),
  z.object({
    t: z.literal('error'),
    code: z.enum([
      'BAD_TICKET',
      'BAD_MESSAGE',
      'NO_PUBLISHER',
      'VIEWER_LIMIT',
      'PUBLISHER_TAKEN',
      'HELLO_TIMEOUT',
    ]),
    message: z.string().optional(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Cliente tem este tempo para mandar `hello` antes do socket cair. */
export const HELLO_TIMEOUT_MS = 5_000;
/** Keepalive — proxies matam WebSocket ocioso. */
export const SIGNAL_PING_INTERVAL_MS = 25_000;
