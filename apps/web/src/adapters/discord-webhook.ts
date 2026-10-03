import { err, ok } from '../core/domain/result.js';
import { urlDoWebhook } from '../core/domain/webhook-discord.js';
import type { ErroDoAviso, PortaDoAvisoDiscord } from '../core/ports/aviso-discord.js';

/**
 * O webhook do Discord por `fetch`, direto do navegador de quem transmite: o
 * Discord libera CORS para a origem do site e para `app://tela`, e o token
 * do canal nunca passa pelo servidor do Tela.
 */
function erroDe(status: number): ErroDoAviso {
  // 401/403/404: webhook apagado ou token errado. O resto pode passar.
  return status === 401 || status === 403 || status === 404 ? 'RECUSADO' : 'FALHOU';
}

export function makeDiscordWebhook(fazer: typeof fetch = (...a) => fetch(...a)): PortaDoAvisoDiscord {
  return {
    async publicar(w, corpo) {
      try {
        // `wait=true`: a resposta traz a mensagem — e o id para editá-la depois.
        const resposta = await fazer(`${urlDoWebhook(w)}?wait=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(corpo),
        });
        if (!resposta.ok) return err(erroDe(resposta.status));
        const mensagem: unknown = await resposta.json();
        const id = typeof mensagem === 'object' && mensagem !== null ? (mensagem as { id?: unknown }).id : undefined;
        return typeof id === 'string' ? ok({ mensagemId: id }) : err('FALHOU');
      } catch {
        return err('FALHOU');
      }
    },
    async editar(w, mensagemId, corpo, opcoes) {
      try {
        const resposta = await fazer(`${urlDoWebhook(w)}/messages/${encodeURIComponent(mensagemId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(corpo),
          // A aba pode estar fechando: `keepalive` deixa o pedido terminar.
          keepalive: opcoes?.aoSair === true,
        });
        return resposta.ok ? ok(undefined) : err(erroDe(resposta.status));
      } catch {
        return err('FALHOU');
      }
    },
  };
}
