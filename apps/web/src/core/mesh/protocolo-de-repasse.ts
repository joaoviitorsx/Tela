/**
 * As mensagens da cascata de repasse (ADR 0031, fase 1), dentro do `payload`
 * opaco do signaling.
 *
 * O servidor só deixa o espectador falar com o anfitrião e nunca abre o
 * `payload` (R8). Por isso o anfitrião é o hub: o espectador que precisa
 * negociar com o pai manda `via` ao anfitrião, e o anfitrião repassa — só entre
 * pares que ELE ligou. O protocolo do servidor não muda (continua 5): um
 * cliente antigo nunca manda `estado` e fica folha do anfitrião, como sempre.
 *
 * O envelope é a chave `repasse`: o `SignalPayload` do `PeerLink` nunca a tem,
 * então as duas famílias não se confundem.
 */

/** Versão do repasse que o espectador entende. Só ele decide se pode ser movido. */
export const VERSAO_DO_REPASSE = 1;

/** Um `via` carrega um `SignalPayload` (SDP ou candidato): nunca passa disto. */
export const MAX_BYTES_DO_VIA = 16_384;

/** Espectador → anfitrião, a cada poucos segundos. */
export type EstadoDoEspectador = {
  readonly repasse: 'estado';
  readonly versao: number;
  /** Navegador com Encoded Transform de recepção, fora de celular. */
  readonly podeRepassar: boolean;
  /** RTT até o anfitrião, medido pelo espectador; `null` = ainda sem medida. */
  readonly rttMs: number | null;
};

/** Repassador → anfitrião, a cada 2 s enquanto tem filhos. */
export type RelatorioDoRepassador = {
  readonly repasse: 'relatorio';
  readonly filhos: number;
  /**
   * A pior estimativa de banda de saída entre as arestas dos filhos, em bits/s
   * (`availableOutgoingBitrate`). `null` = ainda sem medida.
   */
  readonly piorSaidaBps: number | null;
  /** O próprio repassador está perdendo quadro (CPU, decoder): deve largar filho. */
  readonly sobrecarregado: boolean;
};

/**
 * Filho → anfitrião: a imagem do pai chegou. Só então o anfitrião pausa o vídeo
 * direto — até aqui o filho recebe dos dois, e nunca fica sem imagem na troca.
 */
export type ComPai = { readonly repasse: 'com-pai' };
/** Filho → anfitrião: a imagem do pai parou. O anfitrião volta a mandar direto. */
export type SemPai = { readonly repasse: 'sem-pai' };

/** Espectador → anfitrião: sinal para o outro lado da aresta de repasse. */
export type ViaParaAnfitriao = { readonly repasse: 'via'; readonly para: string; readonly dados: unknown };

export type DoEspectador = EstadoDoEspectador | RelatorioDoRepassador | ComPai | SemPai | ViaParaAnfitriao;

/** Anfitrião → filho: quem é o pai agora. `null` = o próprio anfitrião. */
export type DefinirPai = { readonly repasse: 'pai'; readonly pai: string | null };
/** Anfitrião → repassador: comece a mandar para este filho. */
export type NovoFilho = { readonly repasse: 'filho'; readonly filho: string };
/** Anfitrião → repassador: pare de mandar para este filho. */
export type SoltarFilho = { readonly repasse: 'soltar'; readonly filho: string };
/** Anfitrião → espectador: sinal vindo do outro lado da aresta. */
export type ViaDoAnfitriao = { readonly repasse: 'via'; readonly de: string; readonly dados: unknown };

export type DoAnfitriao = DefinirPai | NovoFilho | SoltarFilho | ViaDoAnfitriao;

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const ehId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const ehNumeroOuNulo = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/** O payload é da cascata? Só olha a chave; quem valida é o `ler…`. */
export function ehDoRepasse(payload: unknown): boolean {
  return ehObjeto(payload) && typeof payload['repasse'] === 'string';
}

function cabe(dados: unknown): boolean {
  try {
    return JSON.stringify(dados).length <= MAX_BYTES_DO_VIA;
  } catch {
    return false;
  }
}

/**
 * Valida o que um espectador mandou. Tudo que vem do espectador é entrada não
 * confiável: um campo fora do formato derruba a mensagem inteira (`null`).
 */
export function lerDoEspectador(payload: unknown): DoEspectador | null {
  if (!ehObjeto(payload)) return null;
  switch (payload['repasse']) {
    case 'estado':
      if (typeof payload['versao'] !== 'number' || typeof payload['podeRepassar'] !== 'boolean') return null;
      if (!ehNumeroOuNulo(payload['rttMs'])) return null;
      return {
        repasse: 'estado',
        versao: payload['versao'],
        podeRepassar: payload['podeRepassar'],
        rttMs: payload['rttMs'],
      };
    case 'relatorio': {
      const filhos = payload['filhos'];
      if (typeof filhos !== 'number' || !Number.isInteger(filhos) || filhos < 0 || filhos > 64) return null;
      if (!ehNumeroOuNulo(payload['piorSaidaBps']) || typeof payload['sobrecarregado'] !== 'boolean') return null;
      return {
        repasse: 'relatorio',
        filhos,
        piorSaidaBps: payload['piorSaidaBps'],
        sobrecarregado: payload['sobrecarregado'],
      };
    }
    case 'com-pai':
      return { repasse: 'com-pai' };
    case 'sem-pai':
      return { repasse: 'sem-pai' };
    case 'via':
      if (!ehId(payload['para']) || !cabe(payload['dados'])) return null;
      return { repasse: 'via', para: payload['para'], dados: payload['dados'] };
    default:
      return null;
  }
}

/** Valida o que o anfitrião mandou. O anfitrião também é só mais um navegador. */
export function lerDoAnfitriao(payload: unknown): DoAnfitriao | null {
  if (!ehObjeto(payload)) return null;
  switch (payload['repasse']) {
    case 'pai':
      if (payload['pai'] !== null && !ehId(payload['pai'])) return null;
      return { repasse: 'pai', pai: payload['pai'] };
    case 'filho':
      return ehId(payload['filho']) ? { repasse: 'filho', filho: payload['filho'] } : null;
    case 'soltar':
      return ehId(payload['filho']) ? { repasse: 'soltar', filho: payload['filho'] } : null;
    case 'via':
      if (!ehId(payload['de']) || !cabe(payload['dados'])) return null;
      return { repasse: 'via', de: payload['de'], dados: payload['dados'] };
    default:
      return null;
  }
}
