import { SLUG_RE, type ServerMessage, isBlockedSlug } from '@tela/shared';
import { DEFAULT_LIMITS, type Limits } from './limits.js';
import { type RegistryDeps, type Socket } from './channel-registry.js';

/** Relógio e timers controlados: nenhum teste espera tempo real passar. */
export class TestClock {
  private time = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; task: () => void }>();

  now = (): number => this.time;

  setTimer = (ms: number, task: () => void): (() => void) => {
    const id = (this.seq += 1);
    this.timers.set(id, { at: this.time + ms, task });
    return () => this.timers.delete(id);
  };

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].task();
    }
    this.time = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

export class SpySocket implements Socket {
  readonly sent: ServerMessage[] = [];
  closed = false;

  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
  last(): ServerMessage | undefined {
    return this.sent.at(-1);
  }
  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

/**
 * Deps determinísticas. O hash é fraco de propósito — o teste verifica
 * roteamento e ciclo de vida, não criptografia, e depender de `node:crypto`
 * amarraria o registro a um runtime específico.
 */
export function testDeps(clock: TestClock, overrides: Partial<Limits> = {}): RegistryDeps {
  let counter = 0;
  return {
    limits: { ...DEFAULT_LIMITS, ...overrides },
    now: clock.now,
    setTimer: clock.setTimer,
    hash: (input) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < input.length; i += 1) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16).padStart(8, '0').repeat(8);
    },
    equals: (a, b) => a.length === b.length && a === b,
    // MESMA regra de produção. Uma política de teste mais frouxa que a real
    // faz a suíte aprovar exatamente o que o servidor deveria recusar.
    isValidSlug: (slug) => SLUG_RE.test(slug) && !isBlockedSlug(slug),
    iceServersFor: () => ({ servers: [{ urls: ['stun:test'] }], relayStatus: 'not-configured' }),
    newPeerId: (prefix) => `${prefix}_${(counter += 1).toString().padStart(3, '0')}`,
  };
}
