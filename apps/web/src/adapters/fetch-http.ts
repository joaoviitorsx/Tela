import type { Http, HttpResponse } from '../core/ports/http.js';

async function toResponse(response: Response): Promise<HttpResponse> {
  const text = await response.text();
  if (text.length === 0) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: null };
  }
}

export function makeFetchHttp(baseUrl = ''): Http {
  const url = (path: string) => `${baseUrl}${path}`;

  return {
    async post(path, body) {
      try {
        const response = await fetch(url(path), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await toResponse(response);
      } catch {
        return { status: 0, body: null };
      }
    },

    async get(path) {
      try {
        return await toResponse(await fetch(url(path)));
      } catch {
        return { status: 0, body: null };
      }
    },

    /**
     * `sendBeacon` sobrevive ao unload da página; um `fetch` normal é
     * cancelado pelo browser antes de sair. É o que faz a sala fechar na hora
     * quando o usuário só fecha a aba, em vez de esperar o TTL.
     */
    beacon(path, body) {
      const payload = new Blob([JSON.stringify(body)], { type: 'application/json' });
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        if (navigator.sendBeacon(url(path), payload)) return;
      }
      void fetch(url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => undefined);
    },
  };
}
