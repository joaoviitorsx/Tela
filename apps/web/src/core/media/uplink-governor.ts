/**
 * Mede quanto o link de upload comporta POR ESPECTADOR, com amortecimento.
 *
 * # O erro que este arquivo existe para não repetir
 *
 * A primeira versão lia `availableOutgoingBitrate` e aplicava 75% dele
 * diretamente, uma vez por segundo. O estimador oscila por natureza — ele
 * sobe, sonda, recua — então o encoder recebia um alvo diferente a cada
 * segundo e nunca chegava a estabilizar. O resultado que os usuários
 * relataram foi exatamente o que uma malha de controle sem amortecimento
 * produz: travamento e instabilidade.
 *
 * Uma malha que reage mais rápido do que o sistema assenta oscila. Sempre.
 *
 * Três defesas, nesta ordem:
 *
 * 1. **Aquecimento.** Nos primeiros segundos o controle de congestionamento
 *    ainda está sondando e a estimativa não vale nada. Não se decide nada
 *    com ela.
 * 2. **Suavização.** Média móvel exponencial, para que um vale isolado não
 *    vire uma queda de qualidade.
 * 3. **Histerese.** Só reporta quando o alvo se afasta o bastante do que já
 *    está valendo. Ajuste pequeno não paga o custo de reconfigurar o encoder.
 *
 *    Havia um segundo eixo de histerese, na FRONTEIRA entre "com teto" e "sem
 *    teto", porque um limiar só fazia o governador aplicar e soltar
 *    alternadamente uma vez por segundo quando a média passava perto de
 *    `maxBitrate / UPLINK_SHARE`. Esse eixo saiu junto com a fronteira: não
 *    existem mais dois regimes, existe um número.
 *
 * E um piso: nunca abaixo do menor preset. Uma estimativa ruim não pode
 * estrangular a transmissão até o nada — é melhor deixar o próprio WebRTC
 * descartar pacotes do que desligar a imagem por precaução.
 *
 * # De TETO para ORÇAMENTO (ADR 0017)
 *
 * Este arquivo se chamava governador de teto e só falava quando havia o que
 * RESTRINGIR: se a banda sobrava, ele calava, e quem consumia o silêncio
 * caía no nominal do preset.
 *
 * Consequência medida: um link de 800 Mbps com dois espectadores dá 300 Mbps
 * de orçamento por espectador. O limiar de entrada era 12 Mbps × 0,9, então
 * nenhum teto era aplicado — e o encoder ficava nos 12 Mbps do preset, que
 * são 0,096 bit por pixel. Esse número é o PISO da ADR 0010, o ponto onde a
 * imagem para de quebrar. Não é o ponto onde ela fica boa: movimento alto pede
 * 0,15 a 0,20, e 0,20 em 1080p60 são 24,9 Mbps.
 *
 * O caminho que gastava a banda medida existia, e estava trancado atrás da
 * escassez. Quem tinha banda de sobra nunca chegava nele.
 *
 * Agora o governador reporta o orçamento SEMPRE que ele muda de forma
 * relevante — para cima ou para baixo. Quem decide como gastar é quem sabe a
 * resolução: a sessão escolhe o degrau, e a topologia gasta até o teto útil de
 * bits por pixel. Some com isso a assimetria entre "apertar" e "sobrar", e com
 * ela some o gatilho de Schmitt: não há mais dois regimes para entrar e sair,
 * há um número só, amortecido.
 */

/** Fração da banda estimada que o vídeo pode ocupar. O resto é folga. */
export const UPLINK_SHARE = 0.75;

/** Peso da leitura nova na média móvel. Baixo = mais lento, mais estável. */
const SUAVIZACAO = 0.25;

/** Só reconfigura o encoder se o alvo mudar mais que isto. */
const HISTERESE = 0.25;

/** Leituras ignoradas no início, enquanto o estimador ainda sonda. */
const AQUECIMENTO_AMOSTRAS = 8;

/**
 * Piso ABSOLUTO, contra estimativa absurda — não contra link ruim de verdade.
 *
 * Era o bitrate do menor preset (1,8 Mbps), e a leitura chega POR ESPECTADOR:
 * com cinco espectadores num link de 6 Mbps o piso entregava 1,8 Mbps a cada
 * sender, 9 Mbps de demanda num cano de 6 — 150% do link, justamente o
 * afogamento que este governador existe para impedir. O piso alto protegia
 * contra uma medição ruim passageira, mas medição sustentadamente baixa não é
 * ruído: é o link.
 *
 * 300 kbps é onde o próprio controle de congestionamento do WebRTC começa.
 * Abaixo disso não há vídeo útil, e aí o problema não é o teto.
 */
const PISO_BPS = 300_000;

/**
 * `null` = não mexa (a esmagadora maioria das leituras). `{ bps }` = o
 * orçamento mudou o bastante para valer reconfigurar o encoder.
 *
 * Não existe mais "solte o teto". O orçamento é sempre um número depois do
 * aquecimento; o que mudava era só se ele estava acima ou abaixo do preset, e
 * essa distinção pertence a quem gasta, não a quem mede.
 */
export type DecisaoOrcamento = { readonly bps: number } | null;

export class UplinkGovernor {
  private media: number | null = null;
  private aplicado: number | null = null;
  private amostras = 0;

  /**
   * Estimativa suavizada corrente, por espectador. `null` antes da primeira
   * leitura útil. Serve para guardar entre sessões.
   */
  get estimativa(): number | null {
    return this.amostras > AQUECIMENTO_AMOSTRAS ? this.media : null;
  }

  /**
   * Começa já sabendo, em vez de descobrir do zero.
   *
   * Sem semente, o aquecimento deixa OITO segundos sem teto nenhum no início
   * de toda transmissão — e é justamente quando os espectadores que estavam
   * esperando entram todos de uma vez e o controle de congestionamento sobe
   * procurando o limite do link. O valor vem da sessão anterior no mesmo
   * aparelho: é palpite, mas é palpite medido.
   *
   * Ignora lixo em silêncio: preferência corrompida não pode impedir
   * transmitir.
   */
  seed(bps: number): void {
    if (!Number.isFinite(bps) || bps <= 0) return;
    this.media = bps;
    this.amostras = AQUECIMENTO_AMOSTRAS + 1;
  }

  reset(): void {
    this.media = null;
    this.aplicado = null;
    this.amostras = 0;
  }

  /** Orçamento por espectador atualmente em vigor. `null` antes do aquecimento. */
  get orcamento(): number | null {
    return this.aplicado;
  }

  /**
   * Recebe uma leitura de banda disponível e devolve o orçamento por
   * espectador quando ele mudou o bastante para valer reconfigurar o encoder.
   *
   * `null` significa "não mexa" — o caso da esmagadora maioria das leituras.
   *
   * Antes existia um terceiro retorno, `{ bps: null }`, que mandava SOLTAR o
   * teto e devolver o comando ao nominal do preset. Ele sumiu junto com a
   * ideia de teto: o nominal do preset é um rótulo de calibração, não um alvo,
   * e voltar para ele quando a banda sobra é exatamente o que prendia um link
   * de 800 Mbps em 12 Mbps (ADR 0017).
   *
   * `availableBps` deve chegar POR ESPECTADOR. Em mesh cada espectador recebe
   * uma cópia inteira do vídeo, e o orçamento vira `maxBitrate` de cada sender.
   */
  observe(availableBps: number | null): DecisaoOrcamento {
    if (availableBps === null || !Number.isFinite(availableBps) || availableBps <= 0) {
      return null;
    }

    this.amostras += 1;
    this.media =
      this.media === null ? availableBps : this.media + SUAVIZACAO * (availableBps - this.media);

    // Durante o aquecimento acumula a média, mas não decide nada com ela.
    if (this.amostras <= AQUECIMENTO_AMOSTRAS) return null;

    const alvo = Math.max(PISO_BPS, Math.round(this.media * UPLINK_SHARE));

    // Primeira leitura útil: não há com o que comparar, então vale.
    if (this.aplicado === null) {
      this.aplicado = alvo;
      return { bps: alvo };
    }

    const variacao = Math.abs(alvo - this.aplicado) / this.aplicado;
    if (variacao < HISTERESE) return null;

    this.aplicado = alvo;
    return { bps: alvo };
  }
}
