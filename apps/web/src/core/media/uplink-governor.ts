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

/**
 * Histerese ASSIMÉTRICA, e a assimetria não é gosto — é aritmética.
 *
 * # A catraca de mão única (ADR 0018)
 *
 * Havia um limiar só, `0,25`, e ele tornava a subida IMPOSSÍVEL. A conta:
 *
 *     subir  exige  alvo ≥ 1,25 × aplicado  →  media ≥ 1,25/0,75 = 1,667 × aplicado
 *     cortar exige  alvo ≤ 0,75 × aplicado  →  media ≤ 1,000 × aplicado
 *
 * O problema é que `aplicado` VIRA o `maxBitrate` do sender, e
 * `availableOutgoingBitrate` é a leitura do controle de congestionamento
 * DESSE MESMO sender. A grandeza medida é limitada pela grandeza atuada.
 *
 * O `AimdRateControl` do libwebrtc tampa a estimativa em
 * `1,5 × acked_throughput + 10 kbps`, e `acked ≈ aplicado` sempre que somos
 * nós o limitador — que é o regime permanente aqui.
 *
 *     media alcançável ≤ 1,500 × aplicado
 *     media necessária ≥ 1,667 × aplicado
 *
 * Medido em simulação: link de 800 Mbps, o orçamento trava em 13,5 Mbps no
 * nono segundo e não sobe mais nunca. Os 24,9 Mbps que o `BPP_TETO` autoriza
 * eram inalcançáveis por construção — a ADR 0017 prometeu uma coisa e a
 * aritmética entregava outra. E o par de constantes era o pior possível:
 * `HISTERESE` valia exatamente `1 − UPLINK_SHARE`, o que deixa o sistema
 * encostado na borda do CORTE em regime permanente.
 *
 * # Os números novos
 *
 * O teto de 1,5 limita a razão `alvo/aplicado` a `0,75 × 1,5 = 1,125` por
 * ciclo. Qualquer banda de subida acima de 12,5% trava. `0,06` deixa margem
 * confortável e ainda exige `media ≥ 1,413 × aplicado` — bem acima do ruído.
 *
 * A banda de corte é larga porque um `maxBitrate` NUNCA causa afogamento
 * sozinho: o alocador do WebRTC entrega ao encoder `min(BWE, maxBitrate)`, e
 * o BWE já é delay-based. O teto protege contra o BWE SUPERESTIMAR, não
 * contra nós empurrarmos além dele — então errar para o lado de não cortar
 * custa pouco, e cortar por ruído custa a transmissão inteira.
 */
const SUBIR = 0.06;
const CORTAR = 0.30;

/** Leituras ignoradas no início, enquanto o estimador ainda sonda. */
const AQUECIMENTO_AMOSTRAS = 8;

/**
 * O mesmo aquecimento, POR CAMINHO (ADR 0030).
 *
 * Um caminho novo nasce com a estimativa no `x-google-start-bitrate` — o que
 * já enviamos aos outros — e sobe dali: o AIMD do libwebrtc cresce 8 %/s e só
 * encosta no teto de `1,5 × acked` seis segundos depois (`ln 1,5 / ln 1,08`).
 * Nesse intervalo a leitura dele é a metade da dos caminhos assentados, e
 * entrava no mínimo CRUA, na primeira amostra: com ruído de −20 % o mínimo
 * caía 40 %, a histerese de corte (30 %) disparava e a sala inteira descia um
 * degrau por causa de quem acabou de chegar. Medido no simulador com entrada
 * escalonada: 76 salas grandes presas um degrau abaixo do que o link pagava.
 *
 * Oito amostras é o que a média móvel leva para o peso da primeira leitura
 * cair a 10 % (`0,75^8`) — e é o mesmo prazo que o primeiro caminho já tinha.
 * Durante o aquecimento o caminho é suavizado mas não vota.
 */
export const AQUECIMENTO_POR_CAMINHO = AQUECIMENTO_AMOSTRAS;

/**
 * Exceção ao aquecimento: um caminho que diz carregar menos de 60 % do que
 * cada caminho RECEBE não está subindo, está afogando. A subida parte do que
 * enviamos e, no pior ruído, lê 80 % disso; abaixo de 60 % é um link fraco de
 * verdade — e um amigo em ADSL entrando precisa derrubar a sala na hora, não
 * oito segundos depois (R5).
 */
export const ABSURDO_POR_CAMINHO = 0.6;

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
   * Uma média móvel POR PEER, e o motivo é estatístico.
   *
   * O orçamento é o MÍNIMO entre os caminhos (R5: todos os senders recebem o
   * mesmo `maxBitrate`, então vale o pior). Mas suavizar o mínimo de leituras
   * ruidosas não é o mesmo que o mínimo das leituras suavizadas: com ruído de
   * ±20%, `E[min de N]` vale `0,8 + 0,4/(N+1)` da capacidade real — um viés
   * para baixo que cresce com N.
   *
   * Isso fechava a catraca de novo. Em ALR o estimador reporta até
   * `1,5 × acked`, então a razão alcançável por ciclo é:
   *
   *     alvo/aplicado = 1,125 × (0,8 + 0,4/(N+1))
   *       N=1 → 1,125   sobe          N=3 → 1,013   trava
   *       N=2 → 1,050   trava         N=5 → 0,975   trava
   *
   * Com o limiar de subida em 1,06, a malha voltava a ser incapaz de abrir a
   * partir de DOIS espectadores. Medido: link de 300 Mbps com cinco
   * espectadores congelava em 52% do que o link pagava, para sempre.
   *
   * Suavizando cada peer separadamente, cada média converge para a capacidade
   * verdadeira daquele caminho, e o mínimo delas é o mínimo verdadeiro. O viés
   * desaparece e a razão volta a 1,125 para qualquer N.
   */
  private readonly porPeer = new Map<string, number>();
  /** Amostras de cada caminho: só vota quem passou do aquecimento. */
  private readonly amostrasPorPeer = new Map<string, number>();

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

    /**
     * A semente NÃO preenche `aplicado`, e a tentativa de preencher custou
     * caro.
     *
     * O defeito original era outro: `seed()` punha `amostras = AQUECIMENTO+1`,
     * pulando o aquecimento, então a PRIMEIRA leitura decidia o orçamento da
     * sessão inteira — e se ela caísse enquanto a captura ainda estava nos 5fps
     * do modo ocioso, a transmissão morava ali.
     *
     * A correção foi preencher `aplicado` para que a primeira leitura tivesse
     * de vencer a histerese. E isso criou uma BANDA MORTA: com a semente certa,
     * a medição real cai dentro de [−30%, +6%], `observe()` devolve `null`,
     * `setUplinkBudget` nunca é chamado, e a topologia fica com `orcamento`
     * nulo — usando `tetoUtil` para todo mundo. Pior: `estimativa` já é
     * não-nula, então a escada de pressão também se cala. As duas malhas mudas
     * ao mesmo tempo.
     *
     * Medido em simulação: 101 de 306 cenários com semente correta ficavam
     * mudos, e o pior deles passou 300 segundos pedindo 24,88 Mbps num link de
     * 5 Mbps com cinco espectadores — 0,0068 bit por pixel. A forma em campo é
     * cruel: a PRIMEIRA transmissão funciona, a segunda não, porque a primeira
     * é que grava a semente.
     *
     * A resposta certa é manter só o aquecimento. A média móvel parte do valor
     * lembrado e converge para a realidade em oito amostras (o peso da semente
     * decai para 10%), e `aplicado === null` garante que a primeira decisão
     * DEPOIS do aquecimento sempre emite.
     */
    this.amostras = 0;
  }

  reset(): void {
    this.media = null;
    this.aplicado = null;
    this.amostras = 0;
    this.porPeer.clear();
    this.amostrasPorPeer.clear();
  }

  /** Orçamento por espectador atualmente em vigor. `null` antes do aquecimento. */
  get orcamento(): number | null {
    return this.aplicado;
  }

  /**
   * Assume um orçamento acima do que a estimativa sustenta, para SONDAR
   * (TELA-015). Quem decide quando é a sessão; aqui só se grava, para a
   * próxima leitura comparar contra o valor que de fato está no ar.
   */
  sondar(bps: number): void {
    if (!Number.isFinite(bps) || bps <= 0) return;
    this.aplicado = Math.round(bps);
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
  observe(
    leituras: Readonly<Record<string, number>>,
    opcoes: {
      readonly permitirQueda?: boolean;
      /** O que sai POR caminho agora: a régua do que é absurdo num caminho novo. */
      readonly enviadoPorCaminho?: number;
    } = {},
  ): DecisaoOrcamento {
    const validas = Object.entries(leituras).filter(
      ([, v]) => Number.isFinite(v) && v > 0,
    );
    if (validas.length === 0) return null;

    // Peer que saiu não pode continuar segurando o mínimo.
    const vivos = new Set(validas.map(([id]) => id));
    for (const id of [...this.porPeer.keys()]) {
      if (vivos.has(id)) continue;
      this.porPeer.delete(id);
      this.amostrasPorPeer.delete(id);
    }

    for (const [id, valor] of validas) {
      const antes = this.porPeer.get(id);
      this.porPeer.set(id, antes === undefined ? valor : antes + SUAVIZACAO * (valor - antes));
      this.amostrasPorPeer.set(id, (this.amostrasPorPeer.get(id) ?? 0) + 1);
    }

    this.amostras += 1;
    // O mínimo dos SUAVIZADOS. Ver o bloco de `porPeer` para por que a ordem
    // das duas operações decide se a malha abre ou não.
    const pior = Math.min(...this.votantes(opcoes.enviadoPorCaminho ?? 0));
    // Sem segunda suavização: cada peer já foi suavizado acima, e empilhar
    // duas médias móveis só acrescenta atraso.
    this.media = pior;

    // Durante o aquecimento acumula a média, mas não decide nada com ela.
    if (this.amostras <= AQUECIMENTO_AMOSTRAS) return null;

    const alvo = Math.max(PISO_BPS, Math.round(this.media * UPLINK_SHARE));

    // Primeira leitura útil: não há com o que comparar, então vale.
    if (this.aplicado === null) {
      this.aplicado = alvo;
      return { bps: alvo };
    }

    const variacao = (alvo - this.aplicado) / this.aplicado;
    if (variacao >= 0 ? variacao < SUBIR : -variacao < CORTAR) return null;

    /**
     * Não corta enquanto NÓS somos o limitador por motivo que não é o link.
     *
     * Duas situações medidas no simulador, e as duas produzem uma leitura
     * baixa que não fala sobre a rede:
     *
     * 1. O degrau caiu por CPU, então o teto do sender virou `BPP_TETO × w × h
     *    × fps` do degrau novo. `acked` cai junto, a estimativa cai atrás, e o
     *    governador registra isso como "o link encolheu". Um pico transitório
     *    de CPU virava perda PERMANENTE de orçamento: link de 800 Mbps
     *    terminando 300s em 28% da capacidade, com recuperação projetada para
     *    t≈460s.
     * 2. A cena está parada. O encoder não consome o alvo, `acked` desaba, e o
     *    teto de `1,5 × acked` desce junto — sem a rede ter piorado nada. Aí o
     *    movimento volta e a transmissão já está estrangulada.
     *
     * Subir continua sempre permitido: leitura alta é notícia boa e verdadeira
     * em qualquer regime.
     */
    if (variacao < 0 && opcoes.permitirQueda === false) return null;

    this.aplicado = alvo;
    return { bps: alvo };
  }

  /**
   * Quem entra no mínimo: os caminhos assentados, mais os novos que já estão
   * afogando (`ABSURDO_POR_CAMINHO`). Se ninguém assentou ainda — todos
   * entraram agora —, todos votam: ficar cego seria pior que ler cedo.
   */
  private votantes(enviadoPorCaminho: number): number[] {
    const assentados: number[] = [];
    const afogando: number[] = [];
    for (const [id, media] of this.porPeer) {
      if ((this.amostrasPorPeer.get(id) ?? 0) > AQUECIMENTO_POR_CAMINHO) assentados.push(media);
      else if (enviadoPorCaminho > 0 && media < ABSURDO_POR_CAMINHO * enviadoPorCaminho) afogando.push(media);
    }
    if (assentados.length === 0 && afogando.length === 0) return [...this.porPeer.values()];
    return [...assentados, ...afogando];
  }
}
