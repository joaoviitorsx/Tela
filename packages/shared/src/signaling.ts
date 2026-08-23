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
export type PeerId = z.infer<typeof PeerIdSchema>;

export const SignalingErrorCodeSchema = z.enum([
  'SLUG_TAKEN', // já existe transmissão nesse slug, de outro dono
  'SLUG_INVALID',
  'NOT_HOSTING', // ninguém transmitindo nesse slug
  'CHANNEL_FULL', // MAX_PEERS atingido
  'RATE_LIMITED',
  'OWNER_INVALID',
  'BAD_MESSAGE',
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

/* ───────────────────── cliente → servidor ───────────────────── */

export const ClientMessageSchema = z.discriminatedUnion('type', [
  /** Reivindica o canal. O ownerToken é comparado, nunca logado nem devolvido. */
  z.object({
    type: z.literal('host'),
    slug: z.string().min(1).max(64),
    ownerToken: z.string().min(43).max(256),
  }),
  z.object({ type: z.literal('watch'), slug: z.string().min(1).max(64) }),
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
    maxPeers: z.number().int().min(1),
  }),
  z.object({
    type: z.literal('watching'),
    peerId: PeerIdSchema,
    hostId: PeerIdSchema,
    iceServers: z.array(IceServerSchema),
  }),
  z.object({ type: z.literal('peer-joined'), peerId: PeerIdSchema }),
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
