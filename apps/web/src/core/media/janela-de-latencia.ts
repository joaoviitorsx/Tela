import type { OrigemLatencia } from '../ports/frame-timing.js';
import { mediana } from './relogio-de-captura.js';

/**
 * Mediana e p95 dos últimos quadros — o número que o HUD mostra.
 *
 * A média móvel de `LatencyWatch` serve ao vigia (reage a tendência e ignora
 * pico). Para o ser humano ela é ruim: um quadro de 3 s a deslocava. Mediana é
 * o "atraso típico"; p95 é o "pior que ainda acontece com frequência", que é o
 * que o jogador sente como engasgo.
 *
 * 120 quadros ≈ 2 s a 60 fps: curto o bastante para acompanhar o degrau de
 * uma troca de qualidade, longo o bastante para o p95 ter 6 pontos acima dele.
 */
export const QUADROS_DA_JANELA = 120;

/** Quadros `captura` na janela para ela mandar sobre a `recepcao`. */
export const MINIMO_PARA_CAPTURA = 30;

export type ResumoDaJanela = {
  readonly mediana: number;
  readonly p95: number;
  readonly amostras: number;
  readonly origem: OrigemLatencia;
};

export function percentil(ordenado: readonly number[], p: number): number | null {
  if (ordenado.length === 0) return null;
  const i = Math.min(ordenado.length - 1, Math.max(0, Math.ceil(ordenado.length * p) - 1));
  return ordenado[i] ?? null;
}

/**
 * Uma janela POR origem, porque as origens medem coisas diferentes (`captura`
 * inclui captura, encode e rede; `recepcao` só o que vem depois) — misturar
 * numa mesma mediana não seria nenhuma das duas. O resumo prefere `captura`
 * assim que ela tem amostras suficientes e cai para `recepcao` quando não tem.
 */
export class JanelaDeLatencia {
  private janelas: Record<OrigemLatencia, number[]> = { captura: [], recepcao: [] };
  private semCaptura = 0;

  registrar(ms: number, origem: OrigemLatencia): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > 30_000) return;
    // Cada quadro entra por UMA origem. Uma janela de quadros só `recepcao`
    // esvazia a `captura`: amostra velha não pode mandar no número de agora.
    if (origem === 'captura') this.semCaptura = 0;
    else if (++this.semCaptura >= QUADROS_DA_JANELA) this.janelas.captura = [];
    const j = this.janelas[origem];
    j.push(ms);
    if (j.length > QUADROS_DA_JANELA) j.shift();
  }

  resumo(): ResumoDaJanela | null {
    const origem: OrigemLatencia =
      this.janelas.captura.length >= MINIMO_PARA_CAPTURA ? 'captura' : 'recepcao';
    const valores = this.janelas[origem];
    const m = mediana(valores);
    if (m === null) return null;
    const ord = [...valores].sort((a, b) => a - b);
    return { mediana: m, p95: percentil(ord, 0.95) ?? m, amostras: ord.length, origem };
  }

  reset(): void {
    this.janelas = { captura: [], recepcao: [] };
    this.semCaptura = 0;
  }
}
