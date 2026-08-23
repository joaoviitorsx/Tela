import type { Connection } from '@tela/shared';
import type { RoomName } from '../domain/room.js';
import type { Slug } from '../domain/slug.js';
import type { BroadcastGateway } from '../ports/broadcast-gateway.js';
import type { Clock } from '../ports/clock.js';
import type { Hasher } from '../ports/hasher.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { LiveState, PresenceStore } from '../ports/presence-store.js';
import type { SlugRepository } from '../ports/slug-repository.js';
import type { TokenIssuer } from '../ports/token-issuer.js';

/**
 * Fakes in-memory, não mocks.
 *
 * Um mock verifica que você chamou o método. Um fake verifica que o
 * comportamento resultante está certo — e sobrevive a refatoração da
 * implementação. Estes fakes reproduzem a semântica que os adapters reais
 * precisam ter, incluindo a atomicidade do claim.
 */

export class FakeClock implements Clock {
  constructor(private current = 1_700_000_000_000) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export class FakeHasher implements Hasher {
  hash(input: string): string {
    // Determinístico e do mesmo tamanho do sha256 hex, sem depender de node:crypto.
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0').repeat(8);
  }
  equals(a: string, b: string): boolean {
    return a.length === b.length && a === b;
  }
}

export class FakeIdGenerator implements IdGenerator {
  private counter = 0;
  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter.toString().padStart(4, '0')}`;
  }
}

export class FakeSlugRepository implements SlugRepository {
  readonly rows = new Map<string, { ownerHash: string; createdAt: number; lastSeenAt: number }>();

  async claim(slug: Slug, ownerHash: string, now: number): Promise<boolean> {
    if (this.rows.has(slug)) return false;
    this.rows.set(slug, { ownerHash, createdAt: now, lastSeenAt: now });
    return true;
  }
  async ownerHashOf(slug: Slug): Promise<string | null> {
    return this.rows.get(slug)?.ownerHash ?? null;
  }
  async touch(slug: Slug, now: number): Promise<void> {
    const row = this.rows.get(slug);
    if (row) row.lastSeenAt = now;
  }
  async exists(slug: Slug): Promise<boolean> {
    return this.rows.has(slug);
  }
}

export class FakePresenceStore implements PresenceStore {
  readonly live = new Map<string, LiveState>();
  readonly viewers = new Map<string, Set<string>>();

  async setLive(slug: Slug, state: LiveState): Promise<void> {
    this.live.set(slug, state);
  }
  async renewLive(slug: Slug): Promise<boolean> {
    return this.live.has(slug);
  }
  async getLive(slug: Slug): Promise<LiveState | null> {
    return this.live.get(slug) ?? null;
  }
  async clearLive(slug: Slug): Promise<void> {
    this.live.delete(slug);
  }
  async addViewer(room: RoomName, identity: string): Promise<void> {
    const set = this.viewers.get(room) ?? new Set<string>();
    set.add(identity);
    this.viewers.set(room, set);
  }
  async removeViewer(room: RoomName, identity: string): Promise<void> {
    this.viewers.get(room)?.delete(identity);
  }
  async countViewers(room: RoomName): Promise<number> {
    return this.viewers.get(room)?.size ?? 0;
  }
  async clearViewers(room: RoomName): Promise<void> {
    this.viewers.delete(room);
  }
}

export class FakeBroadcastGateway implements BroadcastGateway {
  readonly rooms = new Map<string, number>();
  healthy = true;
  failNextEnsure = false;

  async ensureRoom(room: RoomName, capacity: number): Promise<void> {
    if (this.failNextEnsure) {
      this.failNextEnsure = false;
      throw new Error('upstream down');
    }
    this.rooms.set(room, capacity);
  }
  async closeRoom(room: RoomName): Promise<void> {
    this.rooms.delete(room);
  }
  async isHealthy(): Promise<boolean> {
    return this.healthy;
  }
}

export class FakeTokenIssuer implements TokenIssuer {
  async forPublisher(room: RoomName, identity: string): Promise<Connection> {
    return { transport: 'sfu', token: `pub:${identity}`, wsUrl: 'wss://test/rtc', room };
  }
  async forViewer(room: RoomName, identity: string): Promise<Connection> {
    return { transport: 'sfu', token: `view:${identity}`, wsUrl: 'wss://test/rtc', room };
  }
}

export const TEST_POLICY = {
  reserved: new Set(['api', 'rtc', 'admin']),
  offensive: new Set(['puta']),
};
