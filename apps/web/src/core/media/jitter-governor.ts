import {
  JITTER_INICIAL_MS,
  JITTER_MAXIMO_MS,
  JITTER_MINIMO_MS,
} from '../mesh/peer-link.js';
import type { RecepcaoStats } from '../ports/media-transport.js';

/**
 * Decide de quanto buffer o espectador precisa, medindo em vez de chutar.
 *
 * # O problema
 *
 * O jitter buffer é a maior fatia de latência que o produto ESCOLHE. As outras
 * — encode, rede, decode, render — são o que são. Esta é decisão nossa.
 *
 * Ela já foi decidida errado duas vezes, nas duas pontas:
 *
 * **Zero.** Não é "buffer pequeno", é buffer nenhum. Todo pacote fora de ordem
 * ou atrasado é descartado, o quadro fica incompleto, o decoder pede keyframe,
 * e keyframe custa de 6 a 10 vezes um quadro normal (medido e publicado pelo
 * Discord). Vira pulso de nitidez e mancha, com cadência irregular que se lê
 * como travamento mesmo com 58ms de RTT.
 *
 * **80ms fixos.** Consertou a cadência e passou a cobrar o pior caso de TODA
 * conexão, inclusive das calmas. Latência paga sem necessidade.
 *
 * # A decisão
 *
 * Um número fixo está errado porque a pergunta não tem resposta fixa: quanto
 * buffer é preciso depende da rede daquele espectador, naquele momento. Então
 * ele se move, dirigido pelo que a própria recepção reporta.
 *
 * **Sobe rápido, desce devagar.** Um congelamento é evidência forte e imediata
 * de que o buffer é curto; calmaria é evidência fraca, que só significa alguma
 * coisa acumulada. É a mesma assimetria da escada de qualidade, pelo mesmo
 * motivo: uma malha que reage mais rápido do que o sistema assenta oscila,
 * sempre.
 */

/** Amostras limpas seguidas antes de tentar devolver latência. */
const CALMARIA_AMOSTRAS = 12;

/** Quanto desce por vez. Pequeno: descer é aposta, subir é resposta. */
const PASSO_DESCIDA_MS = 10;

/** Quanto sobe quando trava. Grande: o custo de errar para baixo é o travamento. */
const PASSO_SUBIDA_MS = 40;

/**
 * Perda que já justifica mais buffer, mesmo sem congelamento registrado.
 *
 * Perda em rajada vira bloco na tela antes de virar `freezeCount`, então
 * esperar o congelamento é esperar demais.
 */
const PERDA_POR_AMOSTRA = 3;

export type DecisaoJitter = { readonly ms: number } | null;

/**
 * O piso que o RTT exige (estudo 2 · T3, estudo 3 · 2). Uma perda só é
 * consertada se o NACK tiver tempo de ir e voltar antes do quadro precisar
 * sair: `J ≥ RTT + 25 ms`; com perda, `2·RTT + 35 ms` (a retransmissão pode
 * se perder também). No modelo, RTT 80 ms com 1% de perda vai de 710 para 17
 * soluços por minuto; em rede local (RTT de poucos ms) o piso desce a 20 ms
 * e devolve 10–30 ms de latência que o piso fixo cobrava de todo mundo.
 *
 * Sem RTT medido (`0`), o piso fixo de sempre. O governador continua subindo
 * na primeira travada: um piso otimista se corrige sozinho.
 */
export const PISO_ABSOLUTO_MS = 20;

/** Leituras de RTT na mediana do piso (O(1): cinco números). */
const AMOSTRAS_DE_RTT = 5;

function medianaDe(valores: readonly number[]): number {
  if (valores.length === 0) return 0;
  const ordem = [...valores].sort((a, b) => a - b);
  return ordem[Math.floor(ordem.length / 2)] ?? 0;
}

export function pisoPeloRtt(rttMs: number, comPerda: boolean): number {
  if (!(rttMs > 0)) return JITTER_MINIMO_MS;
  const piso = comPerda ? 2 * rttMs + 35 : rttMs + 25;
  return Math.round(Math.max(PISO_ABSOLUTO_MS, Math.min(JITTER_MAXIMO_MS, piso)));
}

export class JitterGovernor {
  private alvo = JITTER_INICIAL_MS;
  private calmaria = 0;
  /** O piso em vigor, do RTT medido (`pisoPeloRtt`). */
  private piso = JITTER_MINIMO_MS;
  /**
   * As últimas leituras de RTT: o piso usa a MEDIANA. Um pico isolado (180 ms
   * num link de 20) erguia o buffer de 45 para 205 ms e ele levava ~3 min para
   * descer (revisão de 2026-10-03). Com perda, o RTT da amostra vale na hora.
   */
  private readonly rtts: number[] = [];
  private anterior: { congelamentos: number; perdidos: number } | null = null;

  /** O alvo em vigor, em ms. */
  get atual(): number {
    return this.alvo;
  }

  /**
   * `true` quando o governador já subiu tudo que podia e não tem mais o que
   * tentar.
   *
   * Existe porque o vigia de latência perguntava a coisa errada. Ele usava
   * "o alvo está acima do piso?" como sinal de que o ajuste barato ainda tinha
   * saída — mas com perda sustentada este governador sobe até o TETO e fica
   * lá, porque cada amostra com perda zera a calmaria. O alvo fica em 240ms,
   * acima do piso, e o vigia concluía para sempre que era melhor esperar.
   *
   * Medido: com três pacotes perdidos por segundo — Wi-Fi comum — o vigia
   * nunca disparava. Ele só disparava em link limpo, que é justamente onde o
   * estimador do Chromium NÃO infla o buffer. A malha estava invertida em
   * relação à própria motivação.
   */
  get noTeto(): boolean {
    return this.alvo >= JITTER_MAXIMO_MS;
  }

  /** Ainda há buffer para devolver: acima do piso do RTT e fora do teto. */
  get podeDescer(): boolean {
    return this.alvo > this.piso && !this.noTeto;
  }

  reset(): void {
    this.alvo = JITTER_INICIAL_MS;
    this.calmaria = 0;
    this.anterior = null;
    this.piso = JITTER_MINIMO_MS;
    this.rtts.length = 0;
  }

  /**
   * Uma leitura de recepção. Devolve o alvo novo, ou `null` para não mexer.
   *
   * `null` é o caso da esmagadora maioria das amostras — reconfigurar o buffer
   * de leve a cada segundo produziria justamente a irregularidade de cadência
   * que ele existe para remover.
   */
  observe(recepcao: RecepcaoStats | null, rttMs = 0): DecisaoJitter {
    if (recepcao === null) return null;

    const agora = {
      congelamentos: recepcao.congelamentos,
      perdidos: recepcao.pacotesPerdidos,
    };
    const antes = this.anterior;
    this.anterior = agora;

    // Primeira leitura: só tem total acumulado, não tem delta. Nada a decidir.
    if (antes === null) return null;

    const travou = agora.congelamentos > antes.congelamentos;
    const perdeu = agora.perdidos - antes.perdidos >= PERDA_POR_AMOSTRA;
    if (rttMs > 0) {
      this.rtts.push(rttMs);
      if (this.rtts.length > AMOSTRAS_DE_RTT) this.rtts.shift();
    }
    this.piso = pisoPeloRtt(perdeu ? rttMs : medianaDe(this.rtts), perdeu);

    // O RTT subiu (ou começou a perder): o buffer sobe ao piso JÁ — esperar a
    // travada para descobrir isso é exatamente o soluço que o piso evita.
    if (this.alvo < this.piso) {
      this.alvo = this.piso;
      this.calmaria = 0;
      return { ms: this.alvo };
    }

    if (travou || perdeu) {
      this.calmaria = 0;
      if (this.alvo >= JITTER_MAXIMO_MS) return null;
      this.alvo = Math.min(JITTER_MAXIMO_MS, this.alvo + PASSO_SUBIDA_MS);
      return { ms: this.alvo };
    }

    this.calmaria += 1;
    if (this.calmaria < CALMARIA_AMOSTRAS) return null;
    this.calmaria = 0;

    if (this.alvo <= this.piso) return null;
    this.alvo = Math.max(this.piso, this.alvo - PASSO_DESCIDA_MS);
    return { ms: this.alvo };
  }
}
