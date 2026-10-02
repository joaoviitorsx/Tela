/**
 * A fila do "um encode, N envios" (D0b): decide, para cada quadro-isca de cada
 * sender, qual quadro REAL vai no lugar dele — ou nenhum.
 *
 * Cada `RTCRtpSender` codifica só uma isca minúscula; um transform troca o
 * conteúdo de cada quadro-isca pelo próximo quadro do codificador único. Esta
 * classe é a regra dessa troca, sem DOM nem worker, para poder ser testada.
 *
 * Regras de H.264 que ela não pode quebrar:
 * - quadro P depende do anterior: nenhum quadro é pulado no meio de um GOP;
 * - quem entra, ou pede quadro-chave, só recebe a partir de um IDR NA PONTA —
 *   começar num IDR antigo deixava o sender preso N quadros atrás para sempre,
 *   porque cada vaga leva no máximo um quadro (medido: 17 quadros, ~280 ms);
 * - vaga sem quadro novo não vai ao ar (o transform descarta).
 *
 * Os quadros ficam num anel indexado por `seq % Q`. O codificador numera em
 * ordem e sem buraco, então "o quadro de seq s ainda está guardado" é um teste
 * de intervalo e `anel[s % Q]` é ele: O(1) por vaga, independente de Q. A
 * versão anterior (array + `find`) percorria ~Q entradas em TODA vaga de sender
 * em dia — o caso normal era o pior caso (docs/engenharia/complexidade.md, A1).
 */
export type QuadroCodificado<D> = {
  readonly seq: number;
  readonly chave: boolean;
  readonly dados: D;
};

export type DecisaoDaVaga<D> =
  | { readonly tipo: 'enviar'; readonly quadro: QuadroCodificado<D> }
  | { readonly tipo: 'descartar'; readonly pedirChave: boolean };

/** ~3 s a 60 fps: o bastante para um sender atrasado alcançar sem estourar memória. */
export const QUADROS_GUARDADOS = 180;
/** Sender sem vaga há este tempo está morto (conexão fechada sem avisar o stream). */
export const SENDER_MORTO_MS = 1_000;

/**
 * Pedidos de quadro-chave em rajada viram um IDR: nunca mais de um por esta
 * janela. É o piso; com plateia a janela cresce (`janelaDeChaveMs`).
 */
export const JANELA_MINIMA_DE_CHAVE_MS = 500;
/**
 * Quanto a janela cresce por sender. Um IDR custa B_IDR × N no link (cada
 * sender manda o mesmo quadro), e a taxa de PLI cresce com N (cada caminho
 * perde pacote por conta própria). Com a janela ∝ N, o gasto com IDR fica
 * limitado a B_IDR / 40 ms — constante, em vez de crescer com a plateia
 * (complexidade.md, C4).
 */
export const JANELA_DE_CHAVE_POR_SENDER_MS = 40;
/**
 * Um sender só consegue UM IDR pedido por este intervalo (o da entrada não
 * conta). Sem isto, um espectador quebrado ou mal-intencionado mandando PLI
 * sem parar forçava um IDR por janela para TODO MUNDO — cada IDR vai N vezes.
 * O pedido excedente não vai ao codificador, mas o sender continua esperando o
 * próximo IDR na ponta, então recupera no IDR de qualquer outro ou quando o
 * intervalo vence. 2 s: um espectador custa no máximo B_IDR × N / 2 s, que é
 * 5–10 % do tráfego de P (N × b) em qualquer N (complexidade.md, C4).
 */
export const INTERVALO_MINIMO_DE_CHAVE_POR_SENDER_MS = 2_000;

/**
 * Quadros que um sender pode ficar atrás da ponta enquanto OUTRO está em dia,
 * antes de ser solto da contrapressão. ~100 ms a 60 fps.
 *
 * A contrapressão (`atraso()`) faz o codificador pular quadro de captura
 * enquanto algum sender tem fila: com o MÁXIMO entre todos, um espectador de
 * rede ruim — cujo caminho congestionado faz a isca dele produzir poucas
 * vagas — segurava a imagem da sala inteira. Era "slide" para todo mundo por
 * causa de um. Solto, ele pula para o próximo IDR (pedido dentro da cota de
 * `INTERVALO_MINIMO_DE_CHAVE_POR_SENDER_MS`) e só ele vê o salto.
 *
 * Os parâmetros de encoding continuam idênticos para todos (R5); o orçamento
 * continua coletivo (a malha desce o degrau de todos pela pior estimativa).
 * O que deixa de ser coletivo é só a FILA de um caminho que não acompanha.
 */
export const LIMITE_DE_ARRASTO = 12;
/**
 * Por quanto tempo o sender precisa ficar além do limite, SEM PARAR, para ser
 * solto. Medido: em loopback um sender passa de 6 quadros atrás por instantes
 * o tempo todo (rajadas do pacer, fila do encoder da isca). Soltar no primeiro
 * instante virou 15 IDRs em 30 s e a sala a 22 fps (`e2e/um-encode.e2e.mjs`).
 * Só quem fica para trás por um segundo inteiro tem um caminho que não
 * acompanha — o caso que esta regra existe para isolar.
 */
export const ARRASTO_SUSTENTADO_MS = 1_000;

/**
 * Por quanto tempo um pedido de quadro-chave fica de molho depois do último IDR.
 *
 * `entrada` não paga a janela da plateia: quem acabou de entrar vê tela preta
 * até o primeiro IDR, e a taxa de entradas é limitada por gente (e pelo rate
 * limit do signaling), não por N × perda. Os outros motivos — PLI, sender que
 * ficou para trás, troca de fonte — esperam `max(piso, 40 ms × senders)`.
 */
export function janelaDeChaveMs(senders: number, motivo?: string): number {
  if (motivo === 'entrada' || !Number.isFinite(senders)) return JANELA_MINIMA_DE_CHAVE_MS;
  return Math.max(JANELA_MINIMA_DE_CHAVE_MS, JANELA_DE_CHAVE_POR_SENDER_MS * Math.floor(senders));
}

type EstadoDoSender = {
  proximo: number;
  esperandoChave: boolean;
  ultimaVaga: number;
  /** Instante a partir do qual um pedido deste sender vale de novo. */
  chaveLiberadaEm: number;
  /** Desde quando está além de `LIMITE_DE_ARRASTO`, sem voltar; `null` = em dia. */
  atrasadoDesde: number | null;
};

export type OpcoesDaFila = {
  /**
   * Quantos quadros atrás da ponta um IDR ainda serve para quem espera chave.
   *
   * `0` (o anfitrião): só o IDR NA PONTA — lá cada quadro ganha exatamente uma
   * vaga, e começar atrás prenderia o sender atrasado para sempre. O
   * repassador (ADR 0031) tem relógio de vaga próprio, mais rápido que a
   * chegada: pode perder o instante em que o IDR é a ponta, e as vagas a mais
   * drenam o atraso de entrar uns quadros atrás.
   */
  readonly toleranciaDeEntrada?: number;
};

export class FilaDeInjecao<D> {
  private readonly anel: (QuadroCodificado<D> | undefined)[] = new Array<QuadroCodificado<D> | undefined>(
    QUADROS_GUARDADOS,
  ).fill(undefined);
  private ultimoSeq = -1;
  private ultimaChave = -1;
  private readonly estados = new Map<string, EstadoDoSender>();
  private readonly tolerancia: number;

  constructor(
    private readonly agora: () => number,
    opcoes: OpcoesDaFila = {},
  ) {
    this.tolerancia = Math.max(0, Math.floor(opcoes.toleranciaDeEntrada ?? 0));
  }

  /** Um quadro novo saiu do codificador único. */
  chegou(quadro: QuadroCodificado<D>): void {
    this.anel[quadro.seq % QUADROS_GUARDADOS] = quadro;
    this.ultimoSeq = quadro.seq;
    if (quadro.chave) this.ultimaChave = quadro.seq;
  }

  entrou(sender: string): void {
    this.estados.set(sender, {
      proximo: -1,
      esperandoChave: true,
      ultimaVaga: this.agora(),
      chaveLiberadaEm: -Infinity,
      atrasadoDesde: null,
    });
  }

  saiu(sender: string): void {
    this.estados.delete(sender);
  }

  /** Quantos senders têm vaga aqui — a plateia, vista de quem injeta. */
  senders(): number {
    return this.estados.size;
  }

  /**
   * O espectador deste sender pediu quadro-chave (PLI). Ele volta a esperar um
   * IDR na ponta; a decisão da próxima vaga já pede um ao codificador — se o
   * sender ainda tem direito (`INTERVALO_MINIMO_DE_CHAVE_POR_SENDER_MS`).
   */
  pediuChave(sender: string): void {
    const s = this.estados.get(sender);
    if (s !== undefined) s.esperandoChave = true;
  }

  /** Uma vaga de isca deste sender: vai quadro real ou não vai nada. */
  vaga(sender: string): DecisaoDaVaga<D> {
    let s = this.estados.get(sender);
    if (s === undefined) {
      this.entrou(sender);
      s = this.estados.get(sender)!;
    }
    const agora = this.agora();
    s.ultimaVaga = agora;

    if (s.esperandoChave) {
      const chave = this.chaveUtil();
      if (chave !== undefined && chave.seq >= s.proximo) {
        // O IDR da entrada é de graça; os seguintes gastam o direito do sender.
        if (s.proximo >= 0) s.chaveLiberadaEm = agora + INTERVALO_MINIMO_DE_CHAVE_POR_SENDER_MS;
        s.esperandoChave = false;
        s.proximo = chave.seq + 1;
        return { tipo: 'enviar', quadro: chave };
      }
      return { tipo: 'descartar', pedirChave: agora >= s.chaveLiberadaEm };
    }

    const p = s.proximo;
    if (p >= this.primeiroSeq() && p <= this.ultimoSeq) {
      const quadro = this.anel[p % QUADROS_GUARDADOS];
      if (quadro !== undefined && quadro.seq === p) {
        s.proximo += 1;
        return { tipo: 'enviar', quadro };
      }
      // Buraco na numeração (invariante quebrada): a cadeia de P já era.
      s.esperandoChave = true;
      return { tipo: 'descartar', pedirChave: agora >= s.chaveLiberadaEm };
    }
    // Ficou para trás do que ainda está guardado: só um IDR salva a cadeia.
    if (p < this.primeiroSeq()) {
      s.esperandoChave = true;
      return { tipo: 'descartar', pedirChave: agora >= s.chaveLiberadaEm };
    }
    return { tipo: 'descartar', pedirChave: false };
  }

  /**
   * Solta da contrapressão quem ficou para trás por `ARRASTO_SUSTENTADO_MS`
   * enquanto outro está em dia (ver `LIMITE_DE_ARRASTO`): ele passa a esperar
   * o próximo IDR. Devolve
   * quantos soltou. O(N) senders, chamado a cada leitura de atraso (~10 Hz).
   *
   * Com um sender só, ninguém é solto: aí a fila É a do único espectador, e
   * pular para IDR a cada 100 ms trocaria lentidão por IDRs em rajada.
   *
   * `exigirOutroEmDia = false` é o REPASSADOR (ADR 0031): lá não há codificador
   * a segurar, e a fila de um filho que não acompanha só cresce — ele
   * assistia em câmera lenta, cada vez mais atrasado, até o anel acabar.
   * Solto, pula para o próximo IDR (periódico, do anfitrião).
   */
  soltarArrastados(exigirOutroEmDia = true): number {
    const agora = this.agora();
    const vivo = (s: EstadoDoSender) => agora - s.ultimaVaga <= SENDER_MORTO_MS && !s.esperandoChave && s.proximo >= 0;
    let emDia = false;
    for (const s of this.estados.values()) {
      if (!vivo(s)) continue;
      if (this.ultimoSeq + 1 - s.proximo > LIMITE_DE_ARRASTO) s.atrasadoDesde ??= agora;
      else {
        s.atrasadoDesde = null;
        emDia = true;
      }
    }
    if (exigirOutroEmDia && !emDia) return 0;
    let soltos = 0;
    for (const s of this.estados.values()) {
      if (!vivo(s) || s.atrasadoDesde === null || agora - s.atrasadoDesde < ARRASTO_SUSTENTADO_MS) continue;
      s.esperandoChave = true;
      s.atrasadoDesde = null;
      soltos += 1;
    }
    return soltos;
  }

  /**
   * Quantos quadros o sender VIVO mais atrasado ainda não mandou.
   *
   * O codificador lê isto para a contrapressão: com fila, ele pula um quadro
   * de conteúdo em vez de acumular latência. Sender morto não conta — contá-lo
   * travava a contrapressão e parava o codificador para todo mundo (medido).
   */
  atraso(): number {
    const agora = this.agora();
    let pior = 0;
    for (const s of this.estados.values()) {
      if (agora - s.ultimaVaga > SENDER_MORTO_MS) continue;
      if (s.esperandoChave || s.proximo < 0) continue;
      pior = Math.max(pior, this.ultimoSeq + 1 - s.proximo);
    }
    return pior;
  }

  /** O IDR mais recente, se estiver a até `tolerancia` quadros da ponta. */
  private chaveUtil(): QuadroCodificado<D> | undefined {
    if (this.ultimaChave < 0 || this.ultimoSeq - this.ultimaChave > this.tolerancia) return undefined;
    const quadro = this.anel[this.ultimaChave % QUADROS_GUARDADOS];
    return quadro !== undefined && quadro.seq === this.ultimaChave && quadro.chave ? quadro : undefined;
  }

  /** O seq mais antigo que ainda cabe no anel (ou 0, enquanto ele não encheu). */
  private primeiroSeq(): number {
    return Math.max(0, this.ultimoSeq - QUADROS_GUARDADOS + 1);
  }
}
