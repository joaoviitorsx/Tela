/**
 * O PCM do "só o jogo" no Windows (D3), do lado da página: o formato fixo e a
 * validação do que chega pela `MessagePort`.
 *
 * A porta vem do utility process (o main só a repassa) — ou seja, de um
 * processo que roda código nativo. A página não confia no formato: confere o
 * tipo, que o tamanho é par (estéreo intercalado) e que cabe num bloco
 * sensato antes de empurrar para o anel.
 */
export const TAXA_DO_PCM = 48_000;
export const CANAIS_DO_PCM = 2;
/** O alvo do anel: ~60 ms (PLANO-desktop §4.1). */
export const ALVO_DO_ANEL_EM_QUADROS = 2880;
/** Capacidade: 1 s. Bem acima do teto (3 × alvo), para o descarte nunca depender do tamanho. */
export const CAPACIDADE_DO_ANEL_EM_QUADROS = TAXA_DO_PCM;
/** Um bloco válido tem no máximo meio segundo: o addon manda 10 ms. */
const MAXIMO_DE_FLOATS_POR_BLOCO = TAXA_DO_PCM * CANAIS_DO_PCM * 0.5;

export type BlocoDePcm = { readonly t: 'pcm'; readonly n: number; readonly dados: Float32Array };

/** O bloco, ou `null` para qualquer coisa que não seja um. */
export function blocoValido(mensagem: unknown): BlocoDePcm | null {
  if (typeof mensagem !== 'object' || mensagem === null) return null;
  const m = mensagem as { t?: unknown; n?: unknown; dados?: unknown };
  if (m.t !== 'pcm' || typeof m.n !== 'number' || !(m.dados instanceof Float32Array)) return null;
  const tam = m.dados.length;
  if (tam === 0 || tam % CANAIS_DO_PCM !== 0 || tam > MAXIMO_DE_FLOATS_POR_BLOCO) return null;
  return { t: 'pcm', n: m.n, dados: m.dados };
}
