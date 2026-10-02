import type { RecepcaoStats } from '../ports/media-transport.js';

/**
 * Por que a imagem de quem assiste está aos saltos — do lado de quem assiste.
 *
 * "A transmissão parece estar em slides" chegava sem dizer de quem era o
 * problema, e quem assiste só pode agir sobre o que é dele. As três causas que
 * os contadores de recepção separam:
 *
 * - `rede`: pacotes perdidos ou imagem congelando — a conexão de QUEM ASSISTE
 *   (ou o caminho até ela) não está entregando;
 * - `decodificacao`: quadros chegam e são jogados fora, ou cada um leva mais
 *   para decodificar do que o intervalo entre eles — o computador de quem
 *   assiste não dá conta.
 *
 * Fps baixo SEM nenhuma das duas não vira aviso: pode ser tela parada (a
 * captura só manda quadro quando algo muda) ou a máquina de quem transmite, e
 * nos dois casos não há o que quem assiste fazer. Esse número aparece na barra
 * (quadros por segundo) e o resto fica para o console de quem transmite.
 *
 * Os contadores do navegador são ACUMULADOS; a vigia trabalha com diferenças
 * entre leituras (~1 s). Liga depois de `AMOSTRAS_PARA_AVISAR` leituras ruins
 * dentro da janela, e só desliga depois de `AMOSTRAS_PARA_LIMPAR` boas
 * seguidas: um soluço não acende nada e o aviso não pisca.
 */
export type CausaDaLentidao = 'rede' | 'decodificacao';

/** Leituras na janela deslizante. */
export const JANELA = 8;
export const AMOSTRAS_PARA_AVISAR = 5;
export const AMOSTRAS_PARA_LIMPAR = 6;
/** Pacotes perdidos por segundo a partir dos quais a perda já vira bloco/salto. */
export const PERDA_POR_SEGUNDO = 5;
/** Fração dos quadros jogados fora pelo decoder que já custa fluidez. */
export const DESCARTE_MAXIMO = 0.1;

type Anterior = { readonly t: number; readonly perdidos: number; readonly congelamentos: number; readonly descartados: number };

export class VigiaDeFluidez {
  private anterior: Anterior | null = null;
  private readonly janela: (CausaDaLentidao | null)[] = [];
  private boasSeguidas = 0;
  private atual: CausaDaLentidao | null = null;

  /** `fps`: quadros decodificados por segundo. `agora` em ms. */
  observar(recepcao: RecepcaoStats | null, fps: number, agora: number): CausaDaLentidao | null {
    if (recepcao === null) return this.atual;
    const a = this.anterior;
    this.anterior = {
      t: agora,
      perdidos: recepcao.pacotesPerdidos,
      congelamentos: recepcao.congelamentos,
      descartados: recepcao.quadrosDescartados,
    };
    // Primeira leitura, ou contadores que voltaram (conexão refeita): só base.
    if (a === null || recepcao.pacotesPerdidos < a.perdidos || recepcao.congelamentos < a.congelamentos) {
      return this.atual;
    }
    const segundos = Math.max(0.001, (agora - a.t) / 1000);
    const perdaPorSegundo = (recepcao.pacotesPerdidos - a.perdidos) / segundos;
    const congelou = recepcao.congelamentos > a.congelamentos;
    const descartadosPorSegundo = Math.max(0, recepcao.quadrosDescartados - a.descartados) / segundos;
    const decodeLento =
      recepcao.decodeMs !== null && fps > 0 && recepcao.decodeMs > (1000 / fps) * 0.8;

    const causa: CausaDaLentidao | null =
      descartadosPorSegundo > DESCARTE_MAXIMO * Math.max(1, fps + descartadosPorSegundo) || decodeLento
        ? 'decodificacao'
        : perdaPorSegundo >= PERDA_POR_SEGUNDO || congelou
          ? 'rede'
          : null;

    this.janela.push(causa);
    if (this.janela.length > JANELA) this.janela.shift();
    this.boasSeguidas = causa === null ? this.boasSeguidas + 1 : 0;

    if (this.atual !== null && this.boasSeguidas >= AMOSTRAS_PARA_LIMPAR) this.atual = null;
    if (this.atual === null) {
      const rede = this.janela.filter((c) => c === 'rede').length;
      const decodificacao = this.janela.filter((c) => c === 'decodificacao').length;
      // Decodificação primeiro: decoder sem dar conta também congela, e
      // apontar a rede mandaria a pessoa trocar de Wi-Fi à toa.
      if (decodificacao >= AMOSTRAS_PARA_AVISAR) this.atual = 'decodificacao';
      else if (rede + decodificacao >= AMOSTRAS_PARA_AVISAR) this.atual = 'rede';
    }
    return this.atual;
  }

  reiniciar(): void {
    this.anterior = null;
    this.janela.length = 0;
    this.boasSeguidas = 0;
    this.atual = null;
  }
}
