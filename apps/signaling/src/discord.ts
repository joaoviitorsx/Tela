import { SLUG_RE, isBlockedSlug } from '@tela/shared';
import type { ConfigDoDiscord } from './discord-config.js';
import type { ConsultarEstado } from './estado-do-canal.js';
import type { EstadoPublico } from './worker.js';

/**
 * O Tela no "+" do Discord: o comando `/tela canal:<slug>` de um app
 * user-installable (docs/DISCORD.md).
 *
 * Responde com o link do canal, o estado (no ar ou não, quantos assistem) e um
 * botão ASSISTIR. É tudo. Não lê mensagem, não entra em canal de voz, não
 * guarda nada: o Discord manda a interação, assinada, e recebe a resposta
 * na mesma requisição (R6 — nada de chat, nada de bot).
 *
 * Conteúdo de interação nunca vai para o log: ele carrega usuário, servidor
 * e canal de quem digitou.
 */

/** O Discord manda poucos KB; 32 KB dá folga e corta abuso antes do parse. */
export const LIMITE_DO_CORPO = 32 * 1024;

/**
 * Janela do `X-Signature-Timestamp`. A assinatura cobre o timestamp, então
 * isto só fecha a reapresentação de uma interação antiga capturada.
 */
export const TOLERANCIA_DO_TIMESTAMP_S = 5 * 60;

export const NOME_DO_COMANDO = 'tela';
export const OPCAO_CANAL = 'canal';

/* Tipos do protocolo de interações que este arquivo usa (Discord API v10). */
const INTERACAO_PING = 1;
const INTERACAO_COMANDO = 2;
const RESPOSTA_PONG = 1;
const RESPOSTA_MENSAGEM = 4;
const FLAG_SUPRIMIR_EMBEDS = 1 << 2;
const FLAG_EFEMERA = 1 << 6;
const COMPONENTE_LINHA = 1;
const COMPONENTE_BOTAO = 2;
const BOTAO_LINK = 5;

type OpaqueKey = { readonly __chave?: unique symbol };

/** O subconjunto de WebCrypto para Ed25519 — o Workers tem nativo. */
export type SubtleEd25519 = {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: 'Ed25519' },
    extractable: boolean,
    usages: ['verify'],
  ): Promise<OpaqueKey>;
  verify(algorithm: { name: 'Ed25519' }, key: OpaqueKey, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
};

function hexParaBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * `X-Signature-Ed25519` sobre `timestamp + corpo`, exatamente como chegou.
 * Qualquer coisa fora do formato é `false`: o verificador nunca lança.
 */
export async function assinaturaValida(
  subtle: SubtleEd25519,
  chavePublica: Uint8Array,
  assinaturaHex: string | null,
  timestamp: string | null,
  corpo: string,
  agoraMs: number,
): Promise<boolean> {
  if (assinaturaHex === null || timestamp === null || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(agoraMs / 1000 - Number(timestamp)) > TOLERANCIA_DO_TIMESTAMP_S) return false;
  const assinatura = hexParaBytes(assinaturaHex);
  if (assinatura === null || assinatura.length !== 64) return false;
  try {
    const chave = await subtle.importKey('raw', chavePublica, { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify(
      { name: 'Ed25519' }, chave, assinatura, new TextEncoder().encode(timestamp + corpo),
    );
  } catch {
    return false;
  }
}

/** Lê o corpo até `limite` bytes. `null` = passou do teto (e a leitura para ali). */
export async function lerCorpoLimitado(request: Request, limite: number): Promise<string | null> {
  const declarado = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declarado) && declarado > limite) return null;
  if (request.body === null) return '';
  const leitor = request.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limite) {
      await leitor.cancel();
      return null;
    }
    partes.push(value);
  }
  const tudo = new Uint8Array(total);
  let posicao = 0;
  for (const parte of partes) {
    tudo.set(parte, posicao);
    posicao += parte.byteLength;
  }
  return new TextDecoder().decode(tudo);
}

/**
 * O que a pessoa digitou em `canal:` vira slug. Aceita o nome (`joao`) e o link
 * inteiro colado (`https://tela.../joao`), porque é o que se tem na mão.
 */
export function slugDaOpcao(valor: string): string | null {
  const limpo = valor.trim().toLowerCase().replace(/\/+$/, '');
  const slug = limpo.slice(limpo.lastIndexOf('/') + 1);
  return SLUG_RE.test(slug) && !isBlockedSlug(slug) ? slug : null;
}

type Mensagem = {
  readonly content: string;
  readonly flags: number;
  readonly allowed_mentions: { readonly parse: readonly string[] };
  readonly components?: readonly unknown[];
};

/** Ninguém é marcado por uma resposta do Tela, aconteça o que acontecer. */
const SEM_MENCAO = { parse: [] } as const;

function efemera(content: string): Mensagem {
  return { content, flags: FLAG_EFEMERA, allowed_mentions: SEM_MENCAO };
}

export function mensagemDoCanal(slug: string, link: string, estado: EstadoPublico | null): Mensagem {
  const linha = estado === null
    ? `**${slug}** · não consegui ver agora se está no ar`
    : estado.noAr
      ? `**${slug}** · AO VIVO agora${estado.espectadores > 0 ? ` · ${estado.espectadores} assistindo` : ''}`
      : `**${slug}** · fora do ar`;
  return {
    content: `${linha}\n${link}`,
    // O botão já leva ao canal; a prévia do link repetiria o mesmo estado.
    flags: FLAG_SUPRIMIR_EMBEDS,
    allowed_mentions: SEM_MENCAO,
    components: [{
      type: COMPONENTE_LINHA,
      components: [{ type: COMPONENTE_BOTAO, style: BOTAO_LINK, label: 'ASSISTIR', url: link }],
    }],
  };
}

export function mensagemDeUso(origem: string): Mensagem {
  return efemera(
    `Use \`/${NOME_DO_COMANDO} ${OPCAO_CANAL}:<nome>\` com o nome do canal — o que vem depois da barra no link.\n` +
    `Em \`${origem}/joao\`, o nome é \`joao\`. Para transmitir, abra ${origem}`,
  );
}

const MENSAGEM_NOME_INVALIDO = efemera(
  'Esse não é um nome de canal. Nomes têm de 3 a 25 caracteres: letras minúsculas, números e hífen.',
);

type Interacao = {
  readonly type?: unknown;
  readonly application_id?: unknown;
  readonly data?: { readonly name?: unknown; readonly options?: unknown };
};

function opcaoCanal(data: Interacao['data']): string | null {
  if (!Array.isArray(data?.options)) return null;
  for (const opcao of data.options as unknown[]) {
    if (typeof opcao !== 'object' || opcao === null) continue;
    const { name, value } = opcao as { name?: unknown; value?: unknown };
    if (name === OPCAO_CANAL && typeof value === 'string') return value;
  }
  return null;
}

export type DepsDoDiscord = {
  readonly config: ConfigDoDiscord | null;
  readonly subtle: SubtleEd25519;
  readonly consultar: ConsultarEstado;
  readonly agora?: () => number;
};

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
}

/** `POST /discord/interactions`. */
export async function atenderInteracao(request: Request, deps: DepsDoDiscord): Promise<Response> {
  const config = deps.config;
  if (config === null) return new Response('não encontrado', { status: 404 });
  if (request.method.toUpperCase() !== 'POST') {
    return new Response('método não permitido', { status: 405, headers: { Allow: 'POST' } });
  }

  const corpo = await lerCorpoLimitado(request, LIMITE_DO_CORPO);
  if (corpo === null) return new Response('corpo grande demais', { status: 413 });

  const valida = await assinaturaValida(
    deps.subtle,
    config.chavePublica,
    request.headers.get('X-Signature-Ed25519'),
    request.headers.get('X-Signature-Timestamp'),
    corpo,
    (deps.agora ?? Date.now)(),
  );
  if (!valida) return new Response('assinatura inválida', { status: 401 });

  let interacao: Interacao;
  try {
    const lido: unknown = JSON.parse(corpo);
    if (typeof lido !== 'object' || lido === null) return new Response('corpo inválido', { status: 400 });
    interacao = lido as Interacao;
  } catch {
    return new Response('corpo inválido', { status: 400 });
  }
  if (config.applicationId !== undefined && interacao.application_id !== config.applicationId) {
    return new Response('app errado', { status: 400 });
  }

  if (interacao.type === INTERACAO_PING) return json({ type: RESPOSTA_PONG });
  if (interacao.type !== INTERACAO_COMANDO) return new Response('interação não suportada', { status: 400 });

  const origem = new URL(request.url).origin;
  if (interacao.data?.name !== NOME_DO_COMANDO) {
    return json({ type: RESPOSTA_MENSAGEM, data: mensagemDeUso(origem) });
  }
  const digitado = opcaoCanal(interacao.data);
  if (digitado === null) return json({ type: RESPOSTA_MENSAGEM, data: mensagemDeUso(origem) });

  const slug = slugDaOpcao(digitado);
  if (slug === null) return json({ type: RESPOSTA_MENSAGEM, data: MENSAGEM_NOME_INVALIDO });

  let estado: EstadoPublico | null;
  try {
    estado = await deps.consultar(slug);
  } catch {
    estado = null;
  }
  return json({ type: RESPOSTA_MENSAGEM, data: mensagemDoCanal(slug, `${origem}/${slug}`, estado) });
}
