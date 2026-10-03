import type { Result } from '../domain/result.js';
import type { MensagemDoWebhook, WebhookDiscord } from '../domain/webhook-discord.js';

/**
 * `RECUSADO`: o Discord disse não (webhook apagado, token errado) — tentar de
 * novo não muda nada. `FALHOU`: rede, limite de taxa, Discord fora — pode
 * dar certo depois.
 */
export type ErroDoAviso = 'RECUSADO' | 'FALHOU';

/** Quem fala com o webhook. O adaptador é `fetch`; o teste, um fake. */
export type PortaDoAvisoDiscord = {
  publicar(w: WebhookDiscord, corpo: MensagemDoWebhook): Promise<Result<{ readonly mensagemId: string }, ErroDoAviso>>;
  /**
   * `aoSair`: a página pode estar fechando — o adaptador manda com `keepalive`,
   * que sobrevive ao fechamento da aba.
   */
  editar(
    w: WebhookDiscord,
    mensagemId: string,
    corpo: MensagemDoWebhook,
    opcoes?: { readonly aoSair?: boolean },
  ): Promise<Result<void, ErroDoAviso>>;
};
