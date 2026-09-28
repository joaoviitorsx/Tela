import { describe, expect, it } from 'vitest';
import { FakeScheduler } from '../testing/fakes.js';
import { PeerRecovery } from './peer-recovery.js';

const settle = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

describe('PeerRecovery', () => {
  it('não reinicia uma oscilação curta e cancela a tentativa ao reconectar', async () => {
    const scheduler = new FakeScheduler();
    let restarts = 0;
    let rebuilt = 0;
    const recovery = new PeerRecovery({
      scheduler, beforeRestart: async () => undefined,
      restart: () => { restarts += 1; return true; },
      rebuild: () => { rebuilt += 1; },
      onRecovering: () => undefined, onRecovered: () => undefined,
      onExhausted: () => undefined,
    });
    recovery.observe('disconnected');
    scheduler.advance(2_000);
    recovery.observe('connected');
    scheduler.advance(31_000);
    await settle();
    expect(restarts).toBe(0);
    expect(rebuilt).toBe(0);
  });

  it('faz um restart, uma reconstrução e encerra no prazo sem sobrepor tentativas', async () => {
    const scheduler = new FakeScheduler();
    let restarts = 0;
    let rebuilt = 0;
    let exhausted = 0;
    const recovery = new PeerRecovery({
      scheduler, beforeRestart: async () => undefined,
      restart: () => { restarts += 1; return true; },
      rebuild: () => { rebuilt += 1; },
      onRecovering: () => undefined, onRecovered: () => undefined,
      onExhausted: () => { exhausted += 1; },
    });
    recovery.observe('failed');
    recovery.observe('failed');
    await settle();
    expect(restarts).toBe(1);
    scheduler.advance(10_000);
    expect(rebuilt).toBe(1);
    scheduler.advance(20_000);
    expect(exhausted).toBe(1);
    recovery.close();
  });

  it('preserva a PC desconectada enquanto os bytes de vídeo continuam crescendo', async () => {
    const scheduler = new FakeScheduler();
    let bytes = 100;
    let restarts = 0;
    const recovery = new PeerRecovery({
      scheduler, beforeRestart: async () => undefined,
      mediaBytes: async () => bytes,
      restart: () => { restarts += 1; return true; },
      rebuild: () => undefined,
      onRecovering: () => undefined, onRecovered: () => undefined,
      onExhausted: () => undefined,
    });
    recovery.observe('disconnected');
    await settle();
    bytes = 200;
    scheduler.advance(3_000);
    await settle();
    expect(restarts).toBe(0);
    bytes = 300;
    scheduler.advance(3_000);
    await settle();
    expect(restarts).toBe(0);
    scheduler.advance(3_000);
    await settle();
    expect(restarts).toBe(1);
    recovery.close();
  });

  it('troca de rede recuperada pelo restart conserva a mesma PC', async () => {
    const scheduler = new FakeScheduler();
    let restarted = 0;
    let rebuilt = 0;
    let recovered = 0;
    const recovery = new PeerRecovery({
      scheduler, beforeRestart: async () => undefined,
      restart: () => { restarted += 1; return true; },
      rebuild: () => { rebuilt += 1; },
      onRecovering: () => undefined, onRecovered: () => { recovered += 1; },
      onExhausted: () => undefined,
    });
    recovery.observe('failed');
    await settle();
    recovery.observe('connected');
    scheduler.advance(30_000);
    expect(restarted).toBe(1);
    expect(rebuilt).toBe(0);
    expect(recovered).toBe(1);
    recovery.close();
  });
});
