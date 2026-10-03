import { type Result, err, ok } from './result.js';

/**
 * Um webhook de canal do Discord (Configurações do canal → Integrações →
 * Webhooks → Copiar URL). É o que deixa o Tela postar "fulano está AO VIVO"
 * sozinho, sem bot e sem o servidor do Tela no meio: quem posta é o próprio
 * navegador de quem transmite (o Discord libera CORS para isso).
 *
 * O token é um segredo daquele canal. Ele fica no navegador de quem o colou e
 * vai só para `discord.com` — nunca para o servidor do Tela.
 */
export type WebhookDiscord = { readonly id: string; readonly token: string };

const FORMA =
  /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{5,25})\/([A-Za-z0-9_-]{20,128})\/?(?:\?.*)?$/;

export function lerWebhook(entrada: string): Result<WebhookDiscord, 'WEBHOOK_INVALIDO'> {
  const achado = FORMA.exec(entrada.trim());
  const id = achado?.[1];
  const token = achado?.[2];
  if (id === undefined || token === undefined) return err('WEBHOOK_INVALIDO');
  return ok({ id, token });
}

/** A URL canônica: sempre `discord.com`, versão fixa da API. */
export function urlDoWebhook(w: WebhookDiscord): string {
  return `https://discord.com/api/v10/webhooks/${w.id}/${w.token}`;
}

/** O começo do webhook, para a tela mostrar qual está salvo sem expor o token. */
export function webhookMascarado(w: WebhookDiscord): string {
  return `…/webhooks/${w.id}/${w.token.slice(0, 4)}••••`;
}

/** O corpo que o Discord recebe. `allowed_mentions` vazio: o aviso nunca marca ninguém. */
export type MensagemDoWebhook = {
  readonly username: string;
  readonly avatar_url?: string;
  readonly embeds: readonly {
    readonly title: string;
    readonly url?: string;
    readonly description: string;
    readonly color: number;
  }[];
  readonly allowed_mentions: { readonly parse: readonly never[] };
};

const AMBAR = 0xf2a33a;
const APAGADO = 0x5c606c;

function base(origem: string): Pick<MensagemDoWebhook, 'username' | 'avatar_url' | 'allowed_mentions'> {
  return { username: 'Tela', avatar_url: `${origem}/tela-app-icon.png`, allowed_mentions: { parse: [] } };
}

export function mensagemAoVivo(canal: string, link: string): MensagemDoWebhook {
  return {
    ...base(new URL(link).origin),
    embeds: [
      {
        title: `${canal} está AO VIVO`,
        url: link,
        description: `Clica e assiste no navegador, sem cadastro: ${link}`,
        color: AMBAR,
      },
    ],
  };
}

export function mensagemEncerrada(canal: string, link: string, duracaoMs: number): MensagemDoWebhook {
  return {
    ...base(new URL(link).origin),
    embeds: [
      {
        title: `${canal} · transmissão encerrada`,
        url: link,
        description: `Durou ${duracaoLegivel(duracaoMs)}. Na próxima, é pelo mesmo link.`,
        color: APAGADO,
      },
    ],
  };
}

export function mensagemDeTeste(origem: string): MensagemDoWebhook {
  return {
    ...base(origem),
    embeds: [
      {
        title: 'Tela conectado a este canal',
        description: 'Quando você entrar no ar, o aviso aparece aqui com o link.',
        color: AMBAR,
      },
    ],
  };
}

/** "1h 12min", "8 min", "menos de 1 min". */
export function duracaoLegivel(ms: number): string {
  const minutos = Math.floor(ms / 60_000);
  if (minutos < 1) return 'menos de 1 min';
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}
