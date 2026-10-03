import { type Result, err, ok } from '../domain/result.js';
import { MAX_CANAIS } from '../domain/canais-da-rota.js';

/**
 * A multivisão (ADR 0032): dois canais na tela do espectador, a principal no
 * palco e a secundária num quadro (PiP) ou lado a lado. Puro: quem desenha é
 * a rota, quem conecta é uma `ViewerSession` por canal.
 *
 * `canais` NUNCA muda de ordem por causa de uma troca: é a ordem dos painéis
 * no DOM. Trocar a principal muda só `principal` — e a rota muda só a classe
 * de cada painel. Reordenar o array moveria o `<video>` de lugar; manter a
 * ordem é o que garante "trocar não reconecta".
 */
export type Layout = 'pip' | 'lado-a-lado';
export type Canto = 'inf-dir' | 'inf-esq' | 'sup-dir' | 'sup-esq';
export type TamanhoPip = 'p' | 'm' | 'g';
export type MotivoDaPausa = 'rede' | 'decodificacao';

export type EstadoMultivisao = {
  readonly canais: readonly string[];
  readonly principal: string;
  readonly layout: Layout;
  readonly canto: Canto;
  readonly tamanho: TamanhoPip;
  /** A secundária fechada pela guarda de banda, até a pessoa pedir de volta. */
  readonly pausada: { readonly canal: string; readonly motivo: MotivoDaPausa } | null;
};

/** O que a pessoa escolheu para o quadro, guardado no aparelho. */
export type PreferenciaDaPip = { readonly canto: Canto; readonly tamanho: TamanhoPip };

export const PIP_PADRAO: PreferenciaDaPip = { canto: 'inf-dir', tamanho: 'm' };

export type ErroDaMultivisao = 'CANAL_REPETIDO';

const TAMANHOS: readonly TamanhoPip[] = ['p', 'm', 'g'];

export function iniciarMultivisao(canais: readonly string[], pip: PreferenciaDaPip = PIP_PADRAO): EstadoMultivisao {
  const primeiro = canais[0];
  if (primeiro === undefined) throw new Error('multivisão sem canal');
  return {
    canais: canais.slice(0, MAX_CANAIS),
    principal: primeiro,
    layout: 'pip',
    canto: pip.canto,
    tamanho: pip.tamanho,
    pausada: null,
  };
}

/** O canal que não é a principal, se houver. */
export function secundaria(e: EstadoMultivisao): string | null {
  return e.canais.find((c) => c !== e.principal) ?? null;
}

/** A ordem do link: principal primeiro. */
export function ordemDoLink(e: EstadoMultivisao): readonly string[] {
  const outra = secundaria(e);
  return outra === null ? [e.principal] : [e.principal, outra];
}

/**
 * Põe um canal na tela. Cheio, o novo entra no lugar da secundária: quem
 * aperta `+ TELA` com duas abertas quer ver outra, não ler um "limite".
 */
export function adicionar(e: EstadoMultivisao, canal: string): Result<EstadoMultivisao, ErroDaMultivisao> {
  if (e.canais.includes(canal)) return err('CANAL_REPETIDO');
  if (e.canais.length < MAX_CANAIS) return ok({ ...e, canais: [...e.canais, canal] });
  const sai = secundaria(e);
  return ok({
    ...e,
    canais: e.canais.map((c) => (c === sai ? canal : c)),
    pausada: null,
  });
}

/** A secundária vira principal. Com um canal só, nada muda. */
export function trocar(e: EstadoMultivisao): EstadoMultivisao {
  const outra = secundaria(e);
  return outra === null ? e : focar(e, outra);
}

export function focar(e: EstadoMultivisao, canal: string): EstadoMultivisao {
  if (!e.canais.includes(canal) || canal === e.principal) return e;
  // A pausada que vira principal volta: a principal nunca fica pausada.
  return { ...e, principal: canal, pausada: e.pausada?.canal === canal ? null : e.pausada };
}

/** Tira um canal. Sair a principal promove a outra; o último não sai. */
export function remover(e: EstadoMultivisao, canal: string): EstadoMultivisao {
  if (!e.canais.includes(canal) || e.canais.length === 1) return e;
  const canais = e.canais.filter((c) => c !== canal);
  const principal = canal === e.principal ? (canais[0] ?? e.principal) : e.principal;
  return { ...e, canais, principal, pausada: e.pausada?.canal === canal ? null : e.pausada };
}

export function alternarLayout(e: EstadoMultivisao): EstadoMultivisao {
  return { ...e, layout: e.layout === 'pip' ? 'lado-a-lado' : 'pip' };
}

export function moverPip(e: EstadoMultivisao, canto: Canto): EstadoMultivisao {
  return { ...e, canto };
}

/** `+1` cresce, `-1` diminui, parando nas pontas. */
export function redimensionar(e: EstadoMultivisao, passo: 1 | -1): EstadoMultivisao {
  const i = TAMANHOS.indexOf(e.tamanho);
  const tamanho = TAMANHOS[Math.min(TAMANHOS.length - 1, Math.max(0, i + passo))] ?? e.tamanho;
  return { ...e, tamanho };
}

/** A guarda de banda fecha a secundária. A principal nunca é pausada. */
export function pausar(e: EstadoMultivisao, motivo: MotivoDaPausa): EstadoMultivisao {
  const outra = secundaria(e);
  if (outra === null || e.pausada !== null) return e;
  return { ...e, pausada: { canal: outra, motivo } };
}

export function retomar(e: EstadoMultivisao): EstadoMultivisao {
  return e.pausada === null ? e : { ...e, pausada: null };
}

/** O canto mais perto de um ponto, em frações do palco (0–1). */
export function cantoMaisPerto(x: number, y: number): Canto {
  const v = y < 0.5 ? 'sup' : 'inf';
  const h = x < 0.5 ? 'esq' : 'dir';
  return `${v}-${h}`;
}
