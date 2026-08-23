import { OFFENSIVE, RESERVED } from '@tela/shared';
import type { Redis } from 'ioredis';
import { makeClaimSlug } from './application/claim-slug.js';
import { makeGetLiveStatus } from './application/get-live-status.js';
import { makeHandleRoomEvent } from './application/handle-room-event.js';
import { makeHeartbeatBroadcast } from './application/heartbeat-broadcast.js';
import { makeJoinBroadcast } from './application/join-broadcast.js';
import { makeStartBroadcast } from './application/start-broadcast.js';
import { makeStopBroadcast } from './application/stop-broadcast.js';
import { makeVerifyOwner } from './application/verify-owner.js';
import type { Config } from './config.js';
import type { SlugPolicy } from './domain/slug.js';
import { makeRandomIdGenerator } from './infra/crypto/random-id-generator.js';
import { makeSha256Hasher } from './infra/crypto/sha256-hasher.js';
import { makeLiveKitGateway } from './infra/livekit/broadcast-gateway.livekit.js';
import { makeLiveKitTokenIssuer } from './infra/livekit/token-issuer.livekit.js';
import {
  type WebhookVerifier,
  makeLiveKitWebhookVerifier,
} from './infra/livekit/webhook-verifier.livekit.js';
import { makeMemoryPresenceStore } from './infra/memory/presence-store.memory.js';
import { makeMemorySlugRepository } from './infra/memory/slug-repository.memory.js';
import { makeRedis } from './infra/redis/client.js';
import { makeRedisPresenceStore } from './infra/redis/presence-store.redis.js';
import { makeRedisSlugRepository } from './infra/redis/slug-repository.redis.js';
import { makeP2pGateway } from './infra/signaling/broadcast-gateway.p2p.js';
import { type SignalingHub, makeSignalingHub } from './infra/signaling/hub.js';
import { makeP2pTokenIssuer } from './infra/signaling/token-issuer.p2p.js';
import { systemClock } from './infra/time/system-clock.js';
import type { BroadcastGateway } from './ports/broadcast-gateway.js';

/**
 * Único arquivo do repositório autorizado a importar todas as camadas.
 *
 * A escolha de transporte acontece AQUI e em nenhum outro lugar. Trocar SFU
 * por P2P é trocar quais adapters são instanciados nesta função — nenhum caso
 * de uso, nenhuma rota e nenhum tipo de domínio muda.
 */
export type Deps = {
  readonly policy: SlugPolicy;
  readonly transport: 'sfu' | 'p2p';
  readonly version: string;
  readonly gateway: BroadcastGateway;
  readonly hub: SignalingHub | null;
  readonly webhooks: WebhookVerifier | null;

  readonly claimSlug: ReturnType<typeof makeClaimSlug>;
  readonly verifyOwner: ReturnType<typeof makeVerifyOwner>;
  readonly startBroadcast: ReturnType<typeof makeStartBroadcast>;
  readonly heartbeatBroadcast: ReturnType<typeof makeHeartbeatBroadcast>;
  readonly stopBroadcast: ReturnType<typeof makeStopBroadcast>;
  readonly getLiveStatus: ReturnType<typeof makeGetLiveStatus>;
  readonly joinBroadcast: ReturnType<typeof makeJoinBroadcast>;
  readonly handleRoomEvent: ReturnType<typeof makeHandleRoomEvent>;

  readonly shareUrlFor: (slug: string) => string;
  readonly storeHealthy: () => Promise<boolean>;
  readonly shutdown: () => Promise<void>;
};

export function compose(config: Config): Deps {
  const policy: SlugPolicy = { reserved: RESERVED, offensive: OFFENSIVE };
  const clock = systemClock;
  const hasher = makeSha256Hasher();
  const ids = makeRandomIdGenerator();

  /* ── estado ── */
  let redis: Redis | null = null;
  let storeHealthy: () => Promise<boolean>;

  if (config.store === 'redis') {
    redis = makeRedis(config.REDIS_URL ?? '');
    const client = redis;
    storeHealthy = async () => {
      try {
        return (await client.ping()) === 'PONG';
      } catch {
        return false;
      }
    };
  } else {
    storeHealthy = async () => true;
  }

  const slugs = redis
    ? makeRedisSlugRepository(redis)
    : makeMemorySlugRepository(() => clock.now());
  const presence = redis
    ? makeRedisPresenceStore(redis)
    : makeMemoryPresenceStore(() => clock.now());

  const handleRoomEvent = makeHandleRoomEvent({ presence });

  /* ── transporte de mídia ── */
  let gateway: BroadcastGateway;
  let tokens;
  let hub: SignalingHub | null = null;
  let webhooks: WebhookVerifier | null = null;
  let maxViewers: number;

  if (config.TELA_TRANSPORT === 'sfu') {
    // Validado em config.ts; o `??` existe só para o compilador.
    const key = config.LIVEKIT_API_KEY ?? '';
    const secret = config.LIVEKIT_API_SECRET ?? '';
    maxViewers = config.MAX_VIEWERS;
    gateway = makeLiveKitGateway(config.LIVEKIT_HTTP_URL, key, secret);
    tokens = makeLiveKitTokenIssuer({ apiKey: key, apiSecret: secret, wsUrl: config.LIVEKIT_WS_URL });
    webhooks = makeLiveKitWebhookVerifier(key, secret);
  } else {
    const secret = config.SIGNAL_SECRET ?? '';
    // Em P2P o teto é o upstream e a CPU do transmissor, não a sala.
    maxViewers = config.P2P_MAX_VIEWERS;
    hub = makeSignalingHub({
      secret,
      maxViewers,
      now: () => clock.now(),
      onRoomEvent: (event) => {
        // O hub é síncrono; o caso de uso não. Falha aqui não pode derrubar
        // a sinalização de quem já está conectado.
        void handleRoomEvent(event).catch(() => undefined);
      },
    });
    gateway = makeP2pGateway(hub);
    tokens = makeP2pTokenIssuer({
      secret,
      signalUrl: config.SIGNAL_WS_URL,
      iceServers: config.iceServers,
      maxViewers,
      now: () => clock.now(),
    });
  }

  return {
    policy,
    transport: config.TELA_TRANSPORT,
    version: config.version,
    gateway,
    hub,
    webhooks,

    claimSlug: makeClaimSlug({ slugs, hasher, clock, policy }),
    verifyOwner: makeVerifyOwner({ slugs, hasher, clock }),
    startBroadcast: makeStartBroadcast({ presence, gateway, tokens, ids, clock, maxViewers }),
    heartbeatBroadcast: makeHeartbeatBroadcast({ presence }),
    stopBroadcast: makeStopBroadcast({ presence, gateway }),
    getLiveStatus: makeGetLiveStatus({ presence, policy }),
    joinBroadcast: makeJoinBroadcast({ presence, tokens, ids, policy, maxViewers }),
    handleRoomEvent,

    shareUrlFor: (slug) => `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/${slug}`,
    storeHealthy,
    shutdown: async () => {
      await redis?.quit();
    },
  };
}
