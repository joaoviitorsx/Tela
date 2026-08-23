import { describe, expect, it } from 'vitest';
import { issueTicket, verifyTicket } from './ticket.js';

const SECRET = 's'.repeat(40);
const NOW = 1_700_000_000;
const payload = { room: 'b_joao', identity: 'v_abc', role: 'viewer' as const, exp: NOW + 900 };

describe('ticket de sinalização', () => {
  it('ida e volta preserva o payload', () => {
    expect(verifyTicket(SECRET, issueTicket(SECRET, payload), NOW)).toEqual(payload);
  });

  it('recusa assinatura de outro segredo', () => {
    const t = issueTicket('x'.repeat(40), payload);
    expect(verifyTicket(SECRET, t, NOW)).toBeNull();
  });

  it('recusa payload adulterado', () => {
    const t = issueTicket(SECRET, payload);
    const forged = `${Buffer.from(JSON.stringify({ ...payload, role: 'publisher' })).toString('base64url')}.${t.split('.')[1]}`;
    expect(verifyTicket(SECRET, forged, NOW)).toBeNull();
  });

  it('recusa ticket expirado', () => {
    const t = issueTicket(SECRET, payload);
    expect(verifyTicket(SECRET, t, NOW + 901)).toBeNull();
  });

  it('recusa lixo', () => {
    for (const junk of ['', '.', 'abc', 'a.b', '....']) {
      expect(verifyTicket(SECRET, junk, NOW)).toBeNull();
    }
  });
});
