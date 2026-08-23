import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Credencial de sinalização do modo P2P.
 *
 * Faz o mesmo papel do JWT do LiveKit: prova que a API autorizou este peer a
 * entrar nesta sala com este papel, e expira sozinha. Não é JWT porque não
 * precisa ser — não há terceiro que precise validá-la, só o nosso próprio hub.
 *
 * Formato: base64url(payload JSON) + "." + base64url(HMAC-SHA256)
 */
export type TicketPayload = {
  readonly room: string;
  readonly identity: string;
  readonly role: 'publisher' | 'viewer';
  /** epoch em segundos */
  readonly exp: number;
};

const b64u = (buf: Buffer) => buf.toString('base64url');

function sign(secret: string, body: string): string {
  return b64u(createHmac('sha256', secret).update(body).digest());
}

export function issueTicket(secret: string, payload: TicketPayload): string {
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(secret, body)}`;
}

export function verifyTicket(
  secret: string,
  ticket: string,
  nowSeconds: number,
): TicketPayload | null {
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;

  const body = ticket.slice(0, dot);
  const provided = ticket.slice(dot + 1);
  const expected = sign(secret, body);

  // Comparação em tempo constante, como no ownerHash.
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as TicketPayload).room !== 'string' ||
    typeof (payload as TicketPayload).identity !== 'string' ||
    typeof (payload as TicketPayload).exp !== 'number'
  ) {
    return null;
  }

  const typed = payload as TicketPayload;
  if (typed.role !== 'publisher' && typed.role !== 'viewer') return null;
  if (typed.exp <= nowSeconds) return null;
  return typed;
}
