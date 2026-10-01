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

type EstadoDoSender = {
  proximo: number;
  esperandoChave: boolean;
  ultimaVaga: number;
};

export class FilaDeInjecao<D> {
  private readonly recentes: QuadroCodificado<D>[] = [];
  private ultimoSeq = -1;
  private readonly senders = new Map<string, EstadoDoSender>();

  constructor(private readonly agora: () => number) {}

  /** Um quadro novo saiu do codificador único. */
  chegou(quadro: QuadroCodificado<D>): void {
    this.recentes.push(quadro);
    this.ultimoSeq = quadro.seq;
    if (this.recentes.length > QUADROS_GUARDADOS) this.recentes.shift();
  }

  entrou(sender: string): void {
    this.senders.set(sender, { proximo: -1, esperandoChave: true, ultimaVaga: this.agora() });
  }

  saiu(sender: string): void {
    this.senders.delete(sender);
  }

  /**
   * O espectador deste sender pediu quadro-chave (PLI). Ele volta a esperar um
   * IDR na ponta; a decisão da próxima vaga já pede um ao codificador.
   */
  pediuChave(sender: string): void {
    const s = this.senders.get(sender);
    if (s !== undefined) s.esperandoChave = true;
  }

  /** Uma vaga de isca deste sender: vai quadro real ou não vai nada. */
  vaga(sender: string): DecisaoDaVaga<D> {
    let s = this.senders.get(sender);
    if (s === undefined) {
      this.entrou(sender);
      s = this.senders.get(sender)!;
    }
    s.ultimaVaga = this.agora();

    if (s.esperandoChave) {
      const ponta = this.recentes.at(-1);
      if (ponta !== undefined && ponta.chave && ponta.seq >= s.proximo) {
        s.esperandoChave = false;
        s.proximo = ponta.seq + 1;
        return { tipo: 'enviar', quadro: ponta };
      }
      return { tipo: 'descartar', pedirChave: true };
    }

    const quadro = this.recentes.find((q) => q.seq === s.proximo);
    if (quadro !== undefined) {
      s.proximo += 1;
      return { tipo: 'enviar', quadro };
    }
    // Ficou para trás do que ainda está guardado: só um IDR salva a cadeia.
    const primeiro = this.recentes[0];
    if (primeiro !== undefined && s.proximo < primeiro.seq) {
      s.esperandoChave = true;
      return { tipo: 'descartar', pedirChave: true };
    }
    return { tipo: 'descartar', pedirChave: false };
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
    for (const s of this.senders.values()) {
      if (agora - s.ultimaVaga > SENDER_MORTO_MS) continue;
      if (s.esperandoChave || s.proximo < 0) continue;
      pior = Math.max(pior, this.ultimoSeq + 1 - s.proximo);
    }
    return pior;
  }
}
