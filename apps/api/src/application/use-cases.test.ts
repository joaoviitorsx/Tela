import { beforeEach, describe, expect, it } from 'vitest';
import { unsafeSlug } from '../domain/slug.js';
import { roomNameFor } from '../domain/room.js';
import {
  FakeBroadcastGateway,
  FakeClock,
  FakeHasher,
  FakeIdGenerator,
  FakePresenceStore,
  FakeSlugRepository,
  FakeTokenIssuer,
  TEST_POLICY,
} from '../testing/fakes.js';
import { makeClaimSlug } from './claim-slug.js';
import { makeGetLiveStatus } from './get-live-status.js';
import { makeHandleRoomEvent } from './handle-room-event.js';
import { makeHeartbeatBroadcast } from './heartbeat-broadcast.js';
import { makeJoinBroadcast } from './join-broadcast.js';
import { makeStartBroadcast } from './start-broadcast.js';
import { makeStopBroadcast } from './stop-broadcast.js';
import { makeVerifyOwner } from './verify-owner.js';

const OWNER = 'o'.repeat(43);
const OTHER = 'z'.repeat(43);

function build(maxViewers = 12) {
  const slugs = new FakeSlugRepository();
  const presence = new FakePresenceStore();
  const gateway = new FakeBroadcastGateway();
  const tokens = new FakeTokenIssuer();
  const ids = new FakeIdGenerator();
  const hasher = new FakeHasher();
  const clock = new FakeClock();
  const policy = TEST_POLICY;

  return {
    slugs,
    presence,
    gateway,
    tokens,
    ids,
    hasher,
    clock,
    claimSlug: makeClaimSlug({ slugs, hasher, clock, policy }),
    verifyOwner: makeVerifyOwner({ slugs, hasher, clock }),
    start: makeStartBroadcast({ presence, gateway, tokens, ids, clock, maxViewers }),
    heartbeat: makeHeartbeatBroadcast({ presence }),
    stop: makeStopBroadcast({ presence, gateway }),
    liveStatus: makeGetLiveStatus({ presence, policy }),
    join: makeJoinBroadcast({ presence, tokens, ids, policy, maxViewers }),
    roomEvent: makeHandleRoomEvent({ presence }),
  };
}

describe('claimSlug', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  it('reivindica slug livre', async () => {
    const r = await ctx.claimSlug({ rawSlug: 'joao', ownerToken: OWNER });
    expect(r).toEqual({ ok: true, value: { slug: 'joao' } });
    expect(await ctx.slugs.exists(unsafeSlug('joao'))).toBe(true);
  });

  it('rejeita slug inválido antes de tocar no repositório', async () => {
    const r = await ctx.claimSlug({ rawSlug: '-joao', ownerToken: OWNER });
    expect(r).toEqual({ ok: false, error: { error: 'SLUG_INVALID' } });
    expect(ctx.slugs.rows.size).toBe(0);
  });

  it('rejeita rota reservada', async () => {
    const r = await ctx.claimSlug({ rawSlug: 'api', ownerToken: OWNER });
    expect(r).toEqual({ ok: false, error: { error: 'SLUG_RESERVED' } });
  });

  it('é idempotente para o mesmo dono', async () => {
    await ctx.claimSlug({ rawSlug: 'joao', ownerToken: OWNER });
    const again = await ctx.claimSlug({ rawSlug: 'joao', ownerToken: OWNER });
    expect(again.ok).toBe(true);
  });

  it('devolve SLUG_TAKEN com sugestões livres para outro dono', async () => {
    await ctx.claimSlug({ rawSlug: 'joao', ownerToken: OWNER });
    const r = await ctx.claimSlug({ rawSlug: 'joao', ownerToken: OTHER });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe('SLUG_TAKEN');
    expect(r.error.suggestions).toEqual(['joao2', 'joaobr', 'joao-plays']);
  });

  it('não sugere alternativa que também está ocupada', async () => {
    await ctx.claimSlug({ rawSlug: 'joao', ownerToken: OWNER });
    await ctx.claimSlug({ rawSlug: 'joao2', ownerToken: OWNER });
    const r = await ctx.claimSlug({ rawSlug: 'joao', ownerToken: OTHER });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.suggestions).toEqual(['joaobr', 'joao-plays']);
  });

  it('nunca persiste o ownerToken cru', async () => {
    await ctx.claimSlug({ rawSlug: 'joao', ownerToken: OWNER });
    const stored = JSON.stringify([...ctx.slugs.rows.values()]);
    expect(stored).not.toContain(OWNER);
  });
});

describe('verifyOwner', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.claimSlug({ rawSlug: 'joao', ownerToken: OWNER });
  });

  it('aceita o dono', async () => {
    expect(await ctx.verifyOwner(unsafeSlug('joao'), OWNER)).toEqual({ ok: true, value: 'joao' });
  });

  it('recusa token errado', async () => {
    expect(await ctx.verifyOwner(unsafeSlug('joao'), OTHER)).toEqual({
      ok: false,
      error: 'OWNER_INVALID',
    });
  });

  it('recusa slug inexistente com o MESMO erro — não vira oráculo de enumeração', async () => {
    expect(await ctx.verifyOwner(unsafeSlug('naoexiste'), OWNER)).toEqual({
      ok: false,
      error: 'OWNER_INVALID',
    });
  });

  it('renova lastSeenAt a cada uso', async () => {
    ctx.clock.advance(60_000);
    await ctx.verifyOwner(unsafeSlug('joao'), OWNER);
    expect(ctx.slugs.rows.get('joao')?.lastSeenAt).toBe(ctx.clock.now());
  });
});

describe('startBroadcast', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  it('cria a sala com capacidade = espectadores + 1', async () => {
    await ctx.start(unsafeSlug('joao'));
    expect(ctx.gateway.rooms.get('b_joao')).toBe(13);
  });

  it('marca ao vivo e emite conexão de publisher', async () => {
    const r = await ctx.start(unsafeSlug('joao'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.connection).toMatchObject({ transport: 'sfu', room: 'b_joao' });
    expect(await ctx.presence.getLive(unsafeSlug('joao'))).not.toBeNull();
  });

  it('é idempotente: preserva sala, publisherId e startedAt', async () => {
    const first = await ctx.start(unsafeSlug('joao'));
    const before = await ctx.presence.getLive(unsafeSlug('joao'));
    ctx.clock.advance(30_000);
    const second = await ctx.start(unsafeSlug('joao'));
    const after = await ctx.presence.getLive(unsafeSlug('joao'));

    expect(first.ok && second.ok).toBe(true);
    expect(after?.publisherId).toBe(before?.publisherId);
    expect(after?.startedAt).toBe(before?.startedAt);
  });

  it('devolve UPSTREAM_UNAVAILABLE quando o gateway falha, sem marcar ao vivo', async () => {
    ctx.gateway.failNextEnsure = true;
    const r = await ctx.start(unsafeSlug('joao'));
    expect(r).toEqual({ ok: false, error: 'UPSTREAM_UNAVAILABLE' });
    expect(await ctx.presence.getLive(unsafeSlug('joao'))).toBeNull();
  });
});

describe('heartbeat', () => {
  it('renova e devolve a contagem de espectadores', async () => {
    const ctx = build();
    await ctx.start(unsafeSlug('joao'));
    await ctx.presence.addViewer(roomNameFor(unsafeSlug('joao')), 'v_1');
    expect(await ctx.heartbeat(unsafeSlug('joao'))).toEqual({ ok: true, value: { viewers: 1 } });
  });

  it('não ressuscita transmissão morta', async () => {
    const ctx = build();
    expect(await ctx.heartbeat(unsafeSlug('joao'))).toEqual({ ok: false, error: 'NOT_LIVE' });
  });
});

describe('stopBroadcast', () => {
  it('limpa estado e fecha a sala', async () => {
    const ctx = build();
    await ctx.start(unsafeSlug('joao'));
    await ctx.presence.addViewer(roomNameFor(unsafeSlug('joao')), 'v_1');

    expect(await ctx.stop(unsafeSlug('joao'))).toEqual({ ok: true, value: null });
    expect(await ctx.presence.getLive(unsafeSlug('joao'))).toBeNull();
    expect(await ctx.presence.countViewers(roomNameFor(unsafeSlug('joao')))).toBe(0);
    expect(ctx.gateway.rooms.has('b_joao')).toBe(false);
  });

  it('parar o que já parou é sucesso — sendBeacon não trata erro', async () => {
    const ctx = build();
    expect(await ctx.stop(unsafeSlug('joao'))).toEqual({ ok: true, value: null });
  });
});

describe('getLiveStatus', () => {
  it('offline quando não há transmissão', async () => {
    const ctx = build();
    expect(await ctx.liveStatus('joao')).toEqual({ ok: true, value: { live: false } });
  });

  it('slug inválido responde igual a offline — sem 404, sem oráculo', async () => {
    const ctx = build();
    expect(await ctx.liveStatus('-invalido-')).toEqual({ ok: true, value: { live: false } });
  });

  it('online devolve startedAt em segundos e contagem', async () => {
    const ctx = build();
    await ctx.start(unsafeSlug('joao'));
    await ctx.presence.addViewer(roomNameFor(unsafeSlug('joao')), 'v_1');
    const r = await ctx.liveStatus('joao');
    expect(r).toEqual({
      ok: true,
      value: { live: true, startedAt: Math.floor(ctx.clock.now() / 1000), viewers: 1 },
    });
  });
});

describe('joinBroadcast', () => {
  it('recusa quando não está ao vivo', async () => {
    const ctx = build();
    expect(await ctx.join('joao')).toEqual({ ok: false, error: 'NOT_LIVE' });
  });

  it('slug inválido também é NOT_LIVE', async () => {
    const ctx = build();
    expect(await ctx.join('-x-')).toEqual({ ok: false, error: 'NOT_LIVE' });
  });

  it('emite identidade anônima e reserva a vaga', async () => {
    const ctx = build();
    await ctx.start(unsafeSlug('joao'));
    const r = await ctx.join('joao');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.identity).toMatch(/^v_\d{4}$/);
    expect(await ctx.presence.countViewers(roomNameFor(unsafeSlug('joao')))).toBe(1);
  });

  it('recusa acima do limite de espectadores', async () => {
    const ctx = build(2);
    await ctx.start(unsafeSlug('joao'));
    await ctx.join('joao');
    await ctx.join('joao');
    expect(await ctx.join('joao')).toEqual({ ok: false, error: 'VIEWER_LIMIT' });
  });
});

describe('handleRoomEvent', () => {
  it('ignora sala fora do namespace b_', async () => {
    const ctx = build();
    await ctx.roomEvent({ kind: 'room_finished', room: 'outra' });
    expect(ctx.presence.live.size).toBe(0);
  });

  it('participant_joined de espectador entra na contagem', async () => {
    const ctx = build();
    await ctx.roomEvent({
      kind: 'participant_joined',
      room: 'b_joao',
      identity: 'v_1',
      isPublisher: false,
    });
    expect(await ctx.presence.countViewers(roomNameFor(unsafeSlug('joao')))).toBe(1);
  });

  it('participant_joined do publisher não conta como espectador', async () => {
    const ctx = build();
    await ctx.roomEvent({
      kind: 'participant_joined',
      room: 'b_joao',
      identity: 'p_1',
      isPublisher: true,
    });
    expect(await ctx.presence.countViewers(roomNameFor(unsafeSlug('joao')))).toBe(0);
  });

  it('saída do publisher encerra a transmissão na hora', async () => {
    const ctx = build();
    await ctx.start(unsafeSlug('joao'));
    await ctx.roomEvent({
      kind: 'participant_left',
      room: 'b_joao',
      identity: 'p_0001',
      isPublisher: true,
    });
    expect(await ctx.presence.getLive(unsafeSlug('joao'))).toBeNull();
  });

  it('saída de espectador só decrementa', async () => {
    const ctx = build();
    await ctx.start(unsafeSlug('joao'));
    await ctx.roomEvent({
      kind: 'participant_joined',
      room: 'b_joao',
      identity: 'v_1',
      isPublisher: false,
    });
    await ctx.roomEvent({
      kind: 'participant_left',
      room: 'b_joao',
      identity: 'v_1',
      isPublisher: false,
    });
    expect(await ctx.presence.countViewers(roomNameFor(unsafeSlug('joao')))).toBe(0);
    expect(await ctx.presence.getLive(unsafeSlug('joao'))).not.toBeNull();
  });

  it('room_finished limpa tudo', async () => {
    const ctx = build();
    await ctx.start(unsafeSlug('joao'));
    await ctx.roomEvent({ kind: 'room_finished', room: 'b_joao' });
    expect(await ctx.presence.getLive(unsafeSlug('joao'))).toBeNull();
  });
});
