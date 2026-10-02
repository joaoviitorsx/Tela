import type { AoFecharAoVivo } from './ajustes.js';

/**
 * O que acontece quando a janela é fechada (D4, PLANO §5), como função pura.
 *
 * A regra de ouro: o app nunca some sem controle. Esconder só com bandeja; sem
 * ela a transmissão vira a janela compacta — que continua na tela e no seletor
 * de janelas. Fechar o compacto sem bandeja minimiza, pelo mesmo motivo.
 */
export type EntradaDeFechar = {
  readonly noAr: boolean;
  readonly aoFecharAoVivo: AoFecharAoVivo;
  readonly fecharEmSegundoPlano: boolean;
  readonly temBandeja: boolean;
  readonly modoCompacto: boolean;
};

export type DecisaoDeFechar =
  /** Deixa o `close` seguir: a janela fecha e o app sai. */
  | 'sair'
  /** Ao vivo e a escolha é "encerrar": para a sessão e então sai. */
  | 'encerrar-e-sair'
  /** Primeira vez ao vivo: o renderer pergunta. */
  | 'perguntar'
  | 'esconder'
  | 'compacto'
  | 'minimizar';

export function decidirFechar(e: EntradaDeFechar): DecisaoDeFechar {
  if (!e.noAr) return e.fecharEmSegundoPlano && e.temBandeja ? 'esconder' : 'sair';
  // Já no compacto, "fechar" não pode abrir outro compacto.
  if (e.modoCompacto) return e.temBandeja ? 'esconder' : 'minimizar';
  switch (e.aoFecharAoVivo) {
    case 'perguntar':
      return 'perguntar';
    case 'encerrar':
      return 'encerrar-e-sair';
    case 'segundo-plano':
      return e.temBandeja ? 'esconder' : 'compacto';
  }
}

export type RespostaDeFechar = {
  readonly acao: 'segundo-plano' | 'encerrar' | 'cancelar';
  readonly lembrar: boolean;
};

/** Valida o que o renderer respondeu ao diálogo. */
export function respostaDeFecharValida(bruto: unknown): RespostaDeFechar | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const d = bruto as Record<string, unknown>;
  const acao = d['acao'];
  if (acao !== 'segundo-plano' && acao !== 'encerrar' && acao !== 'cancelar') return null;
  if (typeof d['lembrar'] !== 'boolean') return null;
  // Lembrar um "cancelar" não existe: não há escolha a guardar.
  return { acao, lembrar: acao === 'cancelar' ? false : d['lembrar'] };
}

/** A resposta lembrada, ou `null` quando não há o que gravar. */
export function escolhaParaLembrar(r: RespostaDeFechar): AoFecharAoVivo | null {
  if (!r.lembrar) return null;
  return r.acao === 'segundo-plano' ? 'segundo-plano' : r.acao === 'encerrar' ? 'encerrar' : null;
}

/* ---------------------------------------------------------------- modo */

export type ModoDaJanela = 'normal' | 'compacto';

export function modoValido(bruto: unknown): ModoDaJanela | null {
  return bruto === 'normal' || bruto === 'compacto' ? bruto : null;
}

/** O tamanho do compacto: link, tempo, n/N, LED e dois botões cabem em uma faixa. */
export const TAMANHO_COMPACTO = { width: 440, height: 132 } as const;
/** O mínimo do modo normal (o mesmo do `BrowserWindow`). */
export const MINIMO_NORMAL = { width: 960, height: 600 } as const;

/* --------------------------------------------------------------- queda */

/** Os motivos do `render-process-gone` que o renderer sabe explicar. */
export const MOTIVOS_DE_QUEDA = [
  'crashed',
  'oom',
  'killed',
  'abnormal-exit',
  'launch-failed',
  'integrity-failure',
  'memory-eval',
] as const;
export type MotivoDeQueda = (typeof MOTIVOS_DE_QUEDA)[number];

export function motivoDeQueda(razao: string): MotivoDeQueda | null {
  return (MOTIVOS_DE_QUEDA as readonly string[]).includes(razao) ? (razao as MotivoDeQueda) : null;
}

/**
 * Se o renderer cair em laço (a própria página de recuperação caindo), parar de
 * recarregar: três quedas em 30 s e a janela fica como está.
 */
export const JANELA_DE_QUEDAS_MS = 30_000;
export const MAXIMO_DE_QUEDAS = 3;

export function registrarQueda(quedas: readonly number[], agora: number): { quedas: readonly number[]; recarregar: boolean } {
  const recentes = [...quedas.filter((t) => agora - t < JANELA_DE_QUEDAS_MS), agora];
  return { quedas: recentes, recarregar: recentes.length < MAXIMO_DE_QUEDAS };
}

/**
 * A URL da página de recuperação: a de abertura com `?queda=<motivo>`. Só
 * ao vivo — cair ocioso recarrega a home, sem drama.
 */
export function urlDaRecuperacao(urlInicial: string, motivo: MotivoDeQueda | null, estavaNoAr: boolean): string {
  if (!estavaNoAr) return urlInicial;
  const url = new URL(urlInicial);
  url.searchParams.set('queda', motivo ?? 'crashed');
  return url.toString();
}
