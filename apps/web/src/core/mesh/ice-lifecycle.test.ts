import { describe, expect, it } from 'vitest';
import { FakeScheduler } from '../testing/fakes.js';
import { IceLifecycle } from './ice-lifecycle.js';

const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

describe('IceLifecycle', () => {
  it('renova uma sessão além do TTL e aplica a nova credencial sem restart', async () => {
    const scheduler = new FakeScheduler();
    const applied: string[] = [];
    let refreshes = 0;
    const lifecycle = new IceLifecycle({
      refreshIce: async () => {
        refreshes += 1;
        return {
          iceServers: [{ urls: 'turn:relay.test', username: `u${refreshes}`, credential: 'secret' }],
          relayStatus: 'available' as const,
          issuedAt: scheduler.now(), expiresAt: scheduler.now() + 600_000,
        };
      },
    }, scheduler, (lease) => applied.push(lease.iceServers[0]?.username ?? ''), () => 0);
    lifecycle.use({
      iceServers: [{ urls: 'turn:relay.test', username: 'u0', credential: 'secret' }],
      relayStatus: 'available', issuedAt: 0, expiresAt: 600_000,
    });
    scheduler.advance(600_001);
    await settle();
    expect(refreshes).toBe(1);
    expect(applied).toEqual(['u0', 'u1']);
    lifecycle.close();
  });

  it('coalesce timer e retomada da aba em uma única chamada', async () => {
    const scheduler = new FakeScheduler();
    let refreshes = 0;
    let resolve!: (value: { iceServers: { urls: string }[]; relayStatus: 'available' }) => void;
    const lifecycle = new IceLifecycle({
      refreshIce: () => {
        refreshes += 1;
        return new Promise((done) => { resolve = done; });
      },
    }, scheduler, () => undefined, () => 0);
    lifecycle.use({ iceServers: [{ urls: 'stun:test' }], issuedAt: 0, expiresAt: 10_000 });
    scheduler.advance(8_000);
    scheduler.setVisivel(false);
    scheduler.setVisivel(true);
    expect(refreshes).toBe(1);
    resolve({ iceServers: [{ urls: 'stun:test' }], relayStatus: 'available' });
    await settle();
    lifecycle.close();
  });

  it('mantém a configuração anterior durante indisponibilidade e tenta de novo após expirar', async () => {
    const scheduler = new FakeScheduler();
    const applied: string[] = [];
    let calls = 0;
    const lifecycle = new IceLifecycle({ refreshIce: async () => {
      calls += 1;
      return calls === 1
        ? { iceServers: [{ urls: 'stun:test' }], relayStatus: 'unavailable' as const }
        : { iceServers: [{ urls: 'turn:relay.test', username: 'fresh', credential: 'secret' }],
            relayStatus: 'available' as const, issuedAt: scheduler.now(), expiresAt: scheduler.now() + 10_000 };
    } }, scheduler, (lease) => applied.push(lease.iceServers[0]?.username ?? 'old'), () => 0);
    lifecycle.use({
      iceServers: [{ urls: 'turn:relay.test', username: 'old', credential: 'secret' }],
      relayStatus: 'available', issuedAt: 0, expiresAt: 10_000,
    });
    scheduler.advance(8_000);
    await settle();
    expect(applied).toEqual(['old']);
    scheduler.advance(5_000);
    await settle();
    expect(applied).toEqual(['old', 'fresh']);
    await lifecycle.beforeRestart();
    expect(calls).toBe(2);
    lifecycle.close();
  });
});
