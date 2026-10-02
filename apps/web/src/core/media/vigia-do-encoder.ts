/**
 * O vigia do codificador único: quanto cada quadro leva para sair, e se o
 * encoder parou de entregar (D9, `docs/desktop/D9-gpu-windows.md`).
 *
 * # Por que existe
 *
 * O `VideoEncoder` avisa quando morre (`error`), mas não quando TRAVA: um
 * driver de GPU que para de responder deixa o encoder `configured`, com a
 * fila cheia, e a transmissão congela sem erro nenhum em lugar nenhum. A
 * contrapressão do codificador descarta na entrada quando a fila passa de
 * dois quadros, então o sintoma é só este: quadros oferecidos, nenhum saindo.
 *
 * # O que é "travou", e o que NÃO é
 *
 * Travou = pelo menos `QUADROS_SEM_SAIDA` quadros oferecidos ao encoder E
 * `TRAVA_MS` sem nenhuma saída. As duas condições juntas, porque cada uma
 * sozinha acusa inocentes:
 *
 * - só o tempo: tela parada não produz quadro (a captura do Windows é
 *   "zero-hertz" — sem mudança, sem quadro), e o primeiro quadro depois de
 *   cinco segundos parados pareceria um encoder mudo há cinco segundos;
 * - só a contagem: o primeiro IDR de um encoder de hardware recém-criado pode
 *   levar centenas de ms, e a 60 fps isso já são dezenas de quadros.
 *
 * Quadros que a CONTRAPRESSÃO dos senders pulou não contam: não chegaram ao
 * encoder, e a culpa não é dele.
 *
 * # Custo
 *
 * O(1) por quadro e zero alocação no regime: os instantes de entrada vivem em
 * dois `Float64Array` de tamanho fixo (anel). A saída quase sempre é o mais
 * antigo pendente (o encoder entrega em ordem), então a busca para no
 * primeiro; no pior caso percorre `CAPACIDADE` posições — constante.
 *
 * Saída fora de ordem descarta os mais antigos que ela: em `realtime` o
 * encoder pode pular quadro, e um pendente que nunca vai sair não pode
 * envelhecer no anel.
 */

/** Quadros pendentes acompanhados. A fila do encoder não passa de 3 + o que está no hardware. */
export const CAPACIDADE = 16;
/** Sem saída por este tempo, com quadros oferecidos: o encoder travou. */
export const TRAVA_MS = 2_000;
/** Mínimo de quadros oferecidos sem saída para acusar trava (meio segundo a 60 fps). */
export const QUADROS_SEM_SAIDA = 30;

export class VigiaDoEncoder {
  private readonly carimbos = new Float64Array(CAPACIDADE);
  private readonly entradas = new Float64Array(CAPACIDADE);
  /** Índice do mais antigo pendente e quantos há. */
  private inicio = 0;
  private pendentes = 0;
  private somaMs = 0;
  private amostras = 0;
  private ofertadosSemSaida = 0;
  private ultimaSaida = 0;

  /** Encoder novo (ou reconfigurado do zero): nada pendente, relógio da trava zerado. */
  reiniciar(agora: number): void {
    this.inicio = 0;
    this.pendentes = 0;
    this.ofertadosSemSaida = 0;
    this.ultimaSaida = agora;
  }

  /** Um quadro entrou no encoder. */
  entrou(carimbo: number, agora: number): void {
    this.ofertadosSemSaida += 1;
    if (this.pendentes === CAPACIDADE) {
      // Anel cheio: o mais antigo perde a vaga (não vira amostra).
      this.inicio = (this.inicio + 1) % CAPACIDADE;
      this.pendentes -= 1;
    }
    const i = (this.inicio + this.pendentes) % CAPACIDADE;
    this.carimbos[i] = carimbo;
    this.entradas[i] = agora;
    this.pendentes += 1;
  }

  /** Um quadro foi oferecido e o encoder estava com a fila cheia: descartado na entrada. */
  recusado(): void {
    this.ofertadosSemSaida += 1;
  }

  /** O encoder entregou o quadro de `carimbo`. */
  saiu(carimbo: number, agora: number): void {
    this.ofertadosSemSaida = 0;
    this.ultimaSaida = agora;
    for (let k = 0; k < this.pendentes; k++) {
      const i = (this.inicio + k) % CAPACIDADE;
      if (this.carimbos[i] !== carimbo) continue;
      this.somaMs += agora - (this.entradas[i] ?? agora);
      this.amostras += 1;
      // Ele e todos os mais antigos saem: os anteriores foram pulados.
      this.inicio = (i + 1) % CAPACIDADE;
      this.pendentes -= k + 1;
      return;
    }
  }

  /** Quadros oferecidos e nenhuma saída há tempo demais. */
  travou(agora: number): boolean {
    return this.ofertadosSemSaida >= QUADROS_SEM_SAIDA && agora - this.ultimaSaida >= TRAVA_MS;
  }

  /** Média de entrada→saída desde a última leitura, em ms; `null` sem amostra. Zera a média. */
  lerMsPorQuadro(): number | null {
    const media = this.amostras === 0 ? null : this.somaMs / this.amostras;
    this.somaMs = 0;
    this.amostras = 0;
    return media;
  }
}
