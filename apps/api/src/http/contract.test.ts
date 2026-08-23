import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaimResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  JoinResponseSchema,
  LiveStatusSchema,
  PingResponseSchema,
  StartBroadcastResponseSchema,
} from '@tela/shared';
import { parseConfig } from '../config.js';
import { compose } from '../composition.js';
import { buildApp } from './app.js';

/**
 * Contrato HTTP de ponta a ponta, sem container nenhum.
 *
 * Roda em modo P2P + store em memória — que é exatamente o modo de self-host
 * doméstico. Isso não é um atalho de teste: é a mesma composição que um
 * usuário roda no PC dele, o que significa que este arquivo também é o teste
 * de fumaça do modo caseiro.
 */
const OWNER = 'o'.repeat(43);
const OTHER = 'z'.repeat(43);

const ENV = {
  NODE_ENV: 'test',
  TELA_TRANSPORT: 'p2p',
  TELA_STORE: 'memory',
  SIGNAL_SECRET: 's'.repeat(40),
  PUBLIC_BASE_URL: 'https://tela.gg',
  P2P_MAX_VIEWERS: '3',
  LOG_LEVEL: 'fatal',
} satisfies NodeJS.ProcessEnv;

describe('contrato HTTP', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const parsed = parseConfig(ENV);
    if ('problems' in parsed) throw new Error(parsed.problems.join('; '));
    app = await buildApp(parsed.config, compose(parsed.config));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const claim = (slug: string, ownerToken = OWNER) => post('/api/claim', { slug, ownerToken });

  describe('POST /api/claim', () => {
    it('201 com shareUrl no formato do contrato', async () => {
      const res = await claim('joao');
      expect(res.statusCode).toBe(201);
      const body = ClaimResponseSchema.parse(res.json());
      expect(body).toEqual({ slug: 'joao', shareUrl: 'https://tela.gg/joao' });
    });

    it('400 para slug inválido', async () => {
      const res = await claim('-x-');
      expect(res.statusCode).toBe(400);
      expect(ErrorResponseSchema.parse(res.json()).error).toBe('SLUG_INVALID');
    });

    it('400 para rota reservada', async () => {
      const res = await claim('api');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('SLUG_RESERVED');
    });

    it('409 com sugestões quando é de outro dono', async () => {
      await claim('joao');
      const res = await claim('joao', OTHER);
      expect(res.statusCode).toBe(409);
      const body = ErrorResponseSchema.parse(res.json());
      expect(body.error).toBe('SLUG_TAKEN');
      expect(body.suggestions).toEqual(['joao2', 'joaobr', 'joao-plays']);
    });

    it('400 quando o corpo não bate com o schema', async () => {
      expect((await post('/api/claim', { slug: 'joao' })).statusCode).toBe(400);
      expect((await post('/api/claim', {})).statusCode).toBe(400);
    });

    it('429 depois de 5 tentativas na mesma janela', async () => {
      for (let i = 0; i < 5; i += 1) await claim(`slug-${i}`);
      const res = await claim('slug-6');
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe('RATE_LIMITED');
    });
  });

  describe('POST /api/broadcast/start', () => {
    it('devolve conexão p2p com ticket, iceServers e teto de espectadores', async () => {
      await claim('joao');
      const res = await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });
      expect(res.statusCode).toBe(200);

      const body = StartBroadcastResponseSchema.parse(res.json());
      expect(body.shareUrl).toBe('https://tela.gg/joao');
      expect(body.connection.transport).toBe('p2p');
      if (body.connection.transport !== 'p2p') return;
      expect(body.connection.room).toBe('b_joao');
      expect(body.connection.maxViewers).toBe(3);
      expect(body.connection.iceServers.length).toBeGreaterThan(0);
      expect(body.connection.ticket).toContain('.');
    });

    it('401 com token errado', async () => {
      await claim('joao');
      const res = await post('/api/broadcast/start', { slug: 'joao', ownerToken: OTHER });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('OWNER_INVALID');
    });

    it('401 para slug que nunca existiu — mesmo erro, sem oráculo', async () => {
      const res = await post('/api/broadcast/start', { slug: 'naoexiste', ownerToken: OWNER });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('OWNER_INVALID');
    });

    it('é idempotente e mantém a mesma sala', async () => {
      await claim('joao');
      const a = await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });
      const b = await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });
      expect(a.json().connection.room).toBe(b.json().connection.room);
    });
  });

  describe('GET /api/live/:slug', () => {
    it('offline antes de começar, com cache curto', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/live/joao' });
      expect(res.statusCode).toBe(200);
      expect(LiveStatusSchema.parse(res.json())).toEqual({ live: false });
      expect(res.headers['cache-control']).toBe('public, max-age=2');
    });

    it('slug inexistente responde igual a offline — nunca 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/live/jamais-existiu' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ live: false });
    });

    it('online depois do start', async () => {
      await claim('joao');
      await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });
      const res = await app.inject({ method: 'GET', url: '/api/live/joao' });
      const body = LiveStatusSchema.parse(res.json());
      expect(body.live).toBe(true);
      if (!body.live) return;
      expect(body.viewers).toBe(0);
      expect(body.startedAt).toBeGreaterThan(1_600_000_000);
    });
  });

  describe('POST /api/join/:slug', () => {
    it('404 quando não está ao vivo', async () => {
      const res = await post('/api/join/joao', {});
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('NOT_LIVE');
    });

    it('devolve ticket de espectador e identidade anônima', async () => {
      await claim('joao');
      await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });

      const res = await post('/api/join/joao', {});
      expect(res.statusCode).toBe(200);
      const body = JoinResponseSchema.parse(res.json());
      expect(body.identity).toMatch(/^v_[0-9a-z]{8}$/);
      expect(body.connection.transport).toBe('p2p');
    });

    it('não pede nem devolve nenhum dado pessoal', async () => {
      await claim('joao');
      await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });
      const raw = (await post('/api/join/joao', {})).body;
      expect(raw).not.toContain(OWNER);
      expect(raw.toLowerCase()).not.toMatch(/email|nome|cpf|phone/);
    });

    it('503 acima do teto de espectadores', async () => {
      await claim('joao');
      await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });
      for (let i = 0; i < 3; i += 1) expect((await post('/api/join/joao', {})).statusCode).toBe(200);
      const res = await post('/api/join/joao', {});
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('VIEWER_LIMIT');
    });
  });

  describe('ping e stop', () => {
    it('ping renova e conta espectadores', async () => {
      await claim('joao');
      await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });
      await post('/api/join/joao', {});

      const res = await post('/api/broadcast/ping', { slug: 'joao', ownerToken: OWNER });
      expect(res.statusCode).toBe(200);
      expect(PingResponseSchema.parse(res.json())).toEqual({ ok: true, viewers: 1 });
    });

    it('ping sem transmissão viva é 404', async () => {
      await claim('joao');
      const res = await post('/api/broadcast/ping', { slug: 'joao', ownerToken: OWNER });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('NOT_LIVE');
    });

    it('stop encerra e o live volta a false', async () => {
      await claim('joao');
      await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });
      expect((await post('/api/broadcast/stop', { slug: 'joao', ownerToken: OWNER })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/live/joao' })).json()).toEqual({ live: false });
    });

    it('estranho não gasta a cota de ping do transmissor', async () => {
      await claim('joao');
      await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });

      // Slug é público. Um atacante que só conhece o link martela o endpoint
      // com credencial inválida; cada tentativa é 401 e NÃO pode consumir o
      // balde do dono — senão derruba a transmissão em 30s.
      for (let i = 0; i < 30; i += 1) {
        expect((await post('/api/broadcast/ping', { slug: 'joao', ownerToken: OTHER })).statusCode).toBe(401);
      }

      const legitimo = await post('/api/broadcast/ping', { slug: 'joao', ownerToken: OWNER });
      expect(legitimo.statusCode).toBe(200);
    });

    it('o dono ainda tem teto próprio depois de autenticado', async () => {
      await claim('joao');
      await post('/api/broadcast/start', { slug: 'joao', ownerToken: OWNER });

      let ultimo = 200;
      for (let i = 0; i < 15; i += 1) {
        ultimo = (await post('/api/broadcast/ping', { slug: 'joao', ownerToken: OWNER })).statusCode;
      }
      expect(ultimo).toBe(429);
    });

    it('stop repetido continua 200 — sendBeacon não trata erro', async () => {
      await claim('joao');
      await post('/api/broadcast/stop', { slug: 'joao', ownerToken: OWNER });
      expect((await post('/api/broadcast/stop', { slug: 'joao', ownerToken: OWNER })).statusCode).toBe(200);
    });
  });

  describe('GET /api/health', () => {
    it('reporta transporte, store e gateway', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(HealthResponseSchema.parse(res.json())).toEqual({
        ok: true,
        transport: 'p2p',
        store: true,
        gateway: true,
        version: '1.0.0',
      });
    });
  });

  describe('superfície', () => {
    it('rota desconhecida é 404 no formato de erro do contrato', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/nao-existe' });
      expect(res.statusCode).toBe(404);
      expect(ErrorResponseSchema.parse(res.json()).error).toBe('SLUG_UNKNOWN');
    });

    it('webhook do LiveKit não existe no modo P2P', async () => {
      expect((await post('/api/livekit/webhook', {})).statusCode).toBe(404);
    });
  });
});

describe('config', () => {
  it('exige SIGNAL_SECRET no modo p2p', () => {
    const r = parseConfig({ TELA_TRANSPORT: 'p2p' });
    expect('problems' in r && r.problems.join()).toContain('SIGNAL_SECRET');
  });

  it('exige credenciais do LiveKit no modo sfu', () => {
    const r = parseConfig({ TELA_TRANSPORT: 'sfu' });
    expect('problems' in r && r.problems.join()).toContain('LIVEKIT_API_KEY');
  });

  it('escolhe store em memória quando não há REDIS_URL', () => {
    const r = parseConfig(ENV);
    expect('config' in r && r.config.store).toBe('memory');
  });

  it('recusa store em memória com SFU em produção', () => {
    const r = parseConfig({
      NODE_ENV: 'production',
      TELA_TRANSPORT: 'sfu',
      TELA_STORE: 'memory',
      LIVEKIT_API_KEY: 'k',
      LIVEKIT_API_SECRET: 's',
    });
    expect('problems' in r && r.problems.join()).toContain('memory');
  });
});
