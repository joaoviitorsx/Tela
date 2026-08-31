import type { AmostraLatencia } from '../ports/frame-timing.js';

/**
 * O teto duro de latência — a única defesa possível no navegador contra o caso
 * "subiu e nunca voltou".
 *
 * # Por que um vigia, e não um ajuste
 *
 * `jitterBufferTarget` é um PISO, não um alvo: o buffer real é
 * `max(alvo, o que o estimador de jitter calcular)`. Não existe contraparte —
 * nenhuma API do navegador impõe um TETO ao buffer de playout. Então quando o
 * estimador decide que precisa de meio segundo, ele fica com meio segundo, e
 * baixar o nosso piso para 40ms não muda nada.
 *
 * A Rainway resolveu isso do único jeito que existe: um watchdog com
 * `bufferLimitMs: 500` que reiniciava o stream de vídeo inteiro em vez de
 * deixar o buffer crescer. É grosseiro, e é a alavanca que sobra.
 *
 * # A disciplina que impede o falso positivo
 *
 * Um vigia com gatilho errado reinicia transmissão boa, o que é pior que a
 * latência que ele consertaria. Três defesas:
 *
 * 1. **Só depois de o ajuste barato ter falhado.** Enquanto o governador de
 *    jitter ainda tem para onde descer, a resposta é descer — não reconectar.
 * 2. **Sustentado, nunca instantâneo.** Um pico isolado é rotina; o que
 *    justifica o custo é a latência ALTA que não volta.
 * 3. **Uma vez por sessão.** Se reconectar não resolveu, o problema não é o
 *    buffer, e reconectar de novo só troca uma transmissão ruim por nenhuma.
 */

/**
 * Acima disto a transmissão deixou de ser tempo real.
 *
 * O produto promete sub-segundo. Meio segundo é o ponto em que o atraso passa
 * a atrapalhar a conversa que está acontecendo no Discord ao lado — que é o
 * caso de uso inteiro. É também o limiar que a Rainway usou.
 */
export const LATENCIA_LIMITE_MS = 500;

/**
 * Segundos seguidos acima do limite antes de agir.
 *
 * Uma reconexão custa alguns segundos de imagem. Só vale a pena contra um
 * problema que já durou mais que isso.
 */
const AMOSTRAS_PARA_AGIR = 8;

/**
 * Média móvel sobre os QUADROS, e o peso é baixo porque a taxa é alta.
 *
 * Isto roda a 60 Hz, não a 1 Hz como as outras malhas do produto. Um peso de
 * 0,15 responderia em sete quadros — 116ms — e um único quadro de 3 segundos
 * jogaria a média de 120 para 552ms, cruzando o limite sozinho. Um quadro
 * atrasado é engasgo de compositor, não crise de latência.
 *
 * 0,05 responde em ~20 quadros, um terço de segundo. Continua rápido para o
 * que precisa detectar — latência que SOBE E FICA — e imune ao pico isolado.
 */
const SUAVIZACAO = 0.05;

export type EstadoLatencia = {
  /** Latência suavizada, em ms. `null` antes da primeira medida. */
  readonly ms: number | null;
  /** De onde veio — `captura` inclui encode, `recepcao` não. */
  readonly origem: AmostraLatencia['origem'] | null;
  /** `true` enquanto ela está acima do limite. */
  readonly alta: boolean;
};

export class LatencyWatch {
  private media: number | null = null;
  private origem: AmostraLatencia['origem'] | null = null;
  private acima = 0;
  private jaAgiu = false;

  get estado(): EstadoLatencia {
    return {
      ms: this.media,
      origem: this.origem,
      alta: this.media !== null && this.media > LATENCIA_LIMITE_MS,
    };
  }

  reset(): void {
    this.media = null;
    this.origem = null;
    this.acima = 0;
    this.jaAgiu = false;
  }

  /** Uma medida vinda do quadro. Barata de propósito: roda a 60 Hz. */
  registrar(amostra: AmostraLatencia): void {
    if (!Number.isFinite(amostra.ms) || amostra.ms < 0) return;
    // Latência absurda é relógio fora de sincronia, não atraso real.
    if (amostra.ms > 30_000) return;

    this.origem = amostra.origem;
    this.media =
      this.media === null ? amostra.ms : this.media + SUAVIZACAO * (amostra.ms - this.media);
  }

  /**
   * Decide, uma vez por segundo, se é hora de reconectar.
   *
   * `podeAjustar` é o governador de jitter dizendo se ainda tem para onde
   * descer. Enquanto tiver, a resposta é descer: reconectar é o último recurso,
   * não o primeiro.
   */
  deveReconectar(podeAjustar: boolean): boolean {
    if (this.media === null) return false;

    if (this.media <= LATENCIA_LIMITE_MS) {
      this.acima = 0;
      return false;
    }
    // O ajuste barato ainda não se esgotou. Deixa ele tentar.
    if (podeAjustar) {
      this.acima = 0;
      return false;
    }

    this.acima += 1;
    if (this.acima < AMOSTRAS_PARA_AGIR) return false;
    // Uma vez por sessão: se não resolveu, o problema não era o buffer.
    if (this.jaAgiu) return false;

    this.jaAgiu = true;
    this.acima = 0;
    return true;
  }
}
