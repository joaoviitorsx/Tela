import {
  ClaimResponseSchema,
  type Connection,
  ErrorResponseSchema,
  JoinResponseSchema,
  LiveStatusSchema,
  PingResponseSchema,
  StartBroadcastResponseSchema,
  type AppErrorCode,
  type LiveStatus,
} from '@tela/shared';
import type { Http } from '../ports/http.js';

/**
 * Cliente tipado da API.
 *
 * Toda resposta passa pelo schema Zod de `@tela/shared` antes de virar dado do
 * domínio. Isso não é paranoia: o servidor pode estar numa versão mais velha
 * que o bundle que o usuário tem em cache, e um campo faltando vira `undefined`
 * silencioso três telas adiante se ninguém validar aqui.
 *
 * Também não lança para erro esperado — mesmo contrato de `Result` da API.
 */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: AppErrorCode };

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const fail = <T>(error: AppErrorCode): ApiResult<T> => ({ ok: false, error });

/** Alinhado com LIVE_TTL de 30s no servidor: três chances antes de expirar. */
export const HEARTBEAT_MS = 10_000;

function errorOf(body: unknown, fallback: AppErrorCode): AppErrorCode {
  const parsed = ErrorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.error : fallback;
}

export type ClaimOutcome =
  | { ok: true; value: { slug: string; shareUrl: string } }
  | { ok: false; error: AppErrorCode; suggestions: string[] };

export type TelaApi = {
  claim(slug: string, ownerToken: string): Promise<ClaimOutcome>;
  startBroadcast(
    slug: string,
    ownerToken: string,
  ): Promise<ApiResult<{ connection: Connection; shareUrl: string; slug: string }>>;
  ping(slug: string, ownerToken: string): Promise<ApiResult<{ viewers: number }>>;
  stopBeacon(slug: string, ownerToken: string): void;
  liveStatus(slug: string): Promise<ApiResult<LiveStatus>>;
  join(slug: string): Promise<ApiResult<{ connection: Connection; identity: string }>>;
};

export function makeTelaApi(http: Http): TelaApi {
  return {
    async claim(slug, ownerToken) {
      const res = await http.post('/api/claim', { slug, ownerToken });
      if (res.status === 201) {
        const parsed = ClaimResponseSchema.safeParse(res.body);
        if (parsed.success) return { ok: true, value: parsed.data };
        return { ok: false, error: 'UPSTREAM_UNAVAILABLE', suggestions: [] };
      }
      const body = ErrorResponseSchema.safeParse(res.body);
      return {
        ok: false,
        error: body.success ? body.data.error : 'UPSTREAM_UNAVAILABLE',
        suggestions: body.success ? (body.data.suggestions ?? []) : [],
      };
    },

    async startBroadcast(slug, ownerToken) {
      const res = await http.post('/api/broadcast/start', { slug, ownerToken });
      if (res.status !== 200) return fail(errorOf(res.body, 'UPSTREAM_UNAVAILABLE'));
      const parsed = StartBroadcastResponseSchema.safeParse(res.body);
      return parsed.success ? ok(parsed.data) : fail('UPSTREAM_UNAVAILABLE');
    },

    async ping(slug, ownerToken) {
      const res = await http.post('/api/broadcast/ping', { slug, ownerToken });
      if (res.status !== 200) return fail(errorOf(res.body, 'NOT_LIVE'));
      const parsed = PingResponseSchema.safeParse(res.body);
      return parsed.success ? ok({ viewers: parsed.data.viewers }) : fail('UPSTREAM_UNAVAILABLE');
    },

    stopBeacon(slug, ownerToken) {
      http.beacon('/api/broadcast/stop', { slug, ownerToken });
    },

    async liveStatus(slug) {
      const res = await http.get(`/api/live/${encodeURIComponent(slug)}`);
      if (res.status !== 200) return fail('UPSTREAM_UNAVAILABLE');
      const parsed = LiveStatusSchema.safeParse(res.body);
      return parsed.success ? ok(parsed.data) : fail('UPSTREAM_UNAVAILABLE');
    },

    async join(slug) {
      const res = await http.post(`/api/join/${encodeURIComponent(slug)}`, {});
      if (res.status !== 200) return fail(errorOf(res.body, 'NOT_LIVE'));
      const parsed = JoinResponseSchema.safeParse(res.body);
      return parsed.success ? ok(parsed.data) : fail('UPSTREAM_UNAVAILABLE');
    },
  };
}
