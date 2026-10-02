import type { DurableObjectNamespace, EstadoPublico } from './worker.js';

/**
 * Pergunta ao Durable Object de um canal se ele está no ar e quantos assistem.
 *
 * Quem pergunta é quem não abre WebSocket: a prévia do link (crawler do
 * Discord, do WhatsApp) e o comando `/tela` do Discord. A resposta é só
 * `EstadoPublico` — dois campos, nenhum dado de pessoa.
 *
 * # Por que a rota interna não vaza
 *
 * O objeto só recebe requisição do próprio Worker. Tudo que vem de fora e
 * chega a ele passa pelo ramo `/signal/<slug>`, que repassa a URL original —
 * sempre com o prefixo `/signal`. `ROTA_ESTADO` não tem esse prefixo, então
 * ninguém de fora consegue montá-la.
 */
export const ROTA_ESTADO = '/estado';

/**
 * Prazo da pergunta. Curto: quem espera é um crawler montando prévia ou o
 * Discord, que dá 3 s para a interação responder. Estourou, a resposta sai
 * sem estado — nunca atrasada.
 */
export const PRAZO_CONSULTA_MS = 1_500;

/** Quanto uma resposta vale em memória. O mesmo `max-age` da prévia. */
export const VALIDADE_ESTADO_MS = 30_000;

/** Teto de slugs lembrados por isolate: a memória é cache, não índice. */
const TETO_DA_MEMORIA = 500;

export type ConsultarEstado = (slug: string) => Promise<EstadoPublico | null>;

/** `null` = não deu para saber. Quem chama decide o que mostrar no lugar. */
export function lerEstadoPublico(valor: unknown): EstadoPublico | null {
  if (typeof valor !== 'object' || valor === null) return null;
  const { noAr, espectadores } = valor as { noAr?: unknown; espectadores?: unknown };
  if (typeof noAr !== 'boolean') return null;
  if (typeof espectadores !== 'number' || !Number.isInteger(espectadores) || espectadores < 0) return null;
  return { noAr, espectadores };
}

/**
 * A pergunta em si, contra o namespace `CHANNELS`. Erro, prazo ou resposta
 * estranha viram `null`: a prévia volta ao texto genérico e o `/tela` diz que
 * não conseguiu ver — nenhum dos dois pode cair porque o objeto falhou.
 */
export function consultarPeloObjeto(
  canais: DurableObjectNamespace,
  prazoMs: number = PRAZO_CONSULTA_MS,
): ConsultarEstado {
  return async (slug) => {
    let relogio: ReturnType<typeof setTimeout> | undefined;
    const prazo = new Promise<null>((resolve) => {
      relogio = setTimeout(() => resolve(null), prazoMs);
    });
    const pergunta = (async () => {
      try {
        const resposta = await canais.get(canais.idFromName(slug)).fetch(
          new Request(`https://canal${ROTA_ESTADO}`, { method: 'GET' }),
        );
        if (!resposta.ok) return null;
        return lerEstadoPublico(await resposta.json());
      } catch {
        return null;
      }
    })();
    try {
      return await Promise.race([pergunta, prazo]);
    } finally {
      clearTimeout(relogio);
    }
  };
}

/**
 * Memória curta por isolate na frente da consulta.
 *
 * Em `*.workers.dev` a Cache API não guarda nada, então `Cache-Control` só
 * ajuda quem está do lado de lá (o crawler). Sem esta memória, cada colagem do
 * link em cada servidor do Discord acordaria o objeto do canal. Com ela, no
 * máximo uma pergunta por slug a cada 30 s em cada isolate.
 *
 * Falha não é lembrada: a próxima requisição tenta de novo.
 */
export function comMemoria(
  consultar: ConsultarEstado,
  agora: () => number = Date.now,
  validadeMs: number = VALIDADE_ESTADO_MS,
): ConsultarEstado {
  const memoria = new Map<string, { readonly estado: EstadoPublico; readonly ate: number }>();
  return async (slug) => {
    const lembrado = memoria.get(slug);
    if (lembrado !== undefined && lembrado.ate > agora()) return lembrado.estado;
    const estado = await consultar(slug);
    if (estado === null) return null;
    if (memoria.size >= TETO_DA_MEMORIA) memoria.clear();
    memoria.set(slug, { estado, ate: agora() + validadeMs });
    return estado;
  };
}
