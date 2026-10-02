/**
 * Leitor do protocolo de saída do `tela-captura` (nativo/linux/tela-captura.c):
 *
 *   [u32 LE tamanho][u8 tipo][corpo de tamanho-1 bytes]
 *     tipo 1, quadro: [u8 chave][u16 LE largura][u16 LE altura][u32 LE seq][H.264 Annex B]
 *     tipo 2, evento: JSON UTF-8
 *     tipo 3, captura: sem corpo — quadro capturado e descartado (relógio da isca)
 *
 * O cano entrega pedaços arbitrários; isto remonta as mensagens. É a versão
 * TypeScript de `apps/desktop/d0/protocolo-captura.mjs` (o harness de
 * medição), com a mesma estratégia: os pedaços ficam numa lista até a
 * mensagem estar completa e só então cada byte é copiado, UMA vez, direto
 * para o `ArrayBuffer` que vai ser transferido ao renderer. Concatenar a
 * cada pedaço era O(B²/c) por mensagem (docs/engenharia/complexidade.md, A4).
 */
const QUADRO = 1;
const EVENTO = 2;
const CAPTURA = 3;
const CABECALHO_DO_QUADRO = 9;

export type QuadroDoNativo = {
  readonly chave: boolean;
  readonly width: number;
  readonly height: number;
  readonly seq: number;
  /** Cópia própria: vai ser transferida, não compartilhada. */
  readonly dados: ArrayBuffer;
};

/** O JSON do processo, sem forma garantida — quem interpreta valida. */
export type EventoDoNativo = Record<string, unknown>;

export type SaidasDoProtocolo = {
  readonly quadro: (q: QuadroDoNativo) => void;
  readonly evento: (e: EventoDoNativo) => void;
  readonly captura?: () => void;
};

function ehObjeto(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export class LeitorDoProtocolo {
  /** Pedaços ainda não consumidos, do mais velho para o mais novo. */
  private pedacos: Buffer[] = [];
  /** Quanto do primeiro pedaço já foi consumido. */
  private inicio = 0;
  /** Bytes pendentes no total (soma dos pedaços menos `inicio`). */
  private total = 0;
  /**
   * Tamanho da mensagem na cabeça, lido uma vez; -1 enquanto o cabeçalho não
   * chegou. Sem isto, cada pedaço que não completa a mensagem relia o
   * cabeçalho andando a lista — O(pedaços) por pedaço, quadrático de novo.
   */
  private tamanho = -1;

  constructor(private readonly saidas: SaidasDoProtocolo) {}

  /** Bytes à espera do resto da mensagem (diagnóstico e testes). */
  get pendente(): number {
    return this.total;
  }

  receber(pedaco: Buffer): void {
    if (pedaco.length === 0) return;
    this.pedacos.push(pedaco);
    this.total += pedaco.length;
    while (this.total >= 4) {
      if (this.tamanho < 0) this.tamanho = this.lerU32(0);
      const tamanho = this.tamanho;
      if (this.total - 4 < tamanho) break;
      if (tamanho === 0) {
        // Mensagem sem tipo: o protocolo não produz isto; só não trava.
        this.consumir(4);
        continue;
      }
      const tipo = this.byteEm(4);
      if (tipo === QUADRO && tamanho - 1 >= CABECALHO_DO_QUADRO) {
        const cab = this.copiar(5, CABECALHO_DO_QUADRO);
        const dados = new ArrayBuffer(tamanho - 1 - CABECALHO_DO_QUADRO);
        this.copiarPara(new Uint8Array(dados), 5 + CABECALHO_DO_QUADRO, dados.byteLength);
        this.saidas.quadro({
          chave: cab[0] === 1,
          width: cab.readUInt16LE(1),
          height: cab.readUInt16LE(3),
          seq: cab.readUInt32LE(5),
          dados,
        });
      } else if (tipo === CAPTURA) {
        this.saidas.captura?.();
      } else if (tipo === EVENTO) {
        let evento: unknown;
        try {
          evento = JSON.parse(this.copiar(5, tamanho - 1).toString('utf8'));
        } catch {
          evento = null; // Evento ilegível não derruba a transmissão.
        }
        if (ehObjeto(evento)) this.saidas.evento(evento);
      }
      this.consumir(4 + tamanho);
    }
  }

  /** O byte na posição `pos` do pendente (pode cair em qualquer pedaço). */
  private byteEm(pos: number): number {
    let p = this.inicio + pos;
    for (const b of this.pedacos) {
      if (p < b.length) return b[p] ?? 0;
      p -= b.length;
    }
    throw new Error('leitor do protocolo: posição fora do pendente');
  }

  private lerU32(pos: number): number {
    // Caminho normal: os 4 bytes no primeiro pedaço. Na fronteira, byte a byte.
    const b0 = this.pedacos[0];
    if (b0 !== undefined && this.inicio + pos + 4 <= b0.length) return b0.readUInt32LE(this.inicio + pos);
    return (
      (this.byteEm(pos) | (this.byteEm(pos + 1) << 8) | (this.byteEm(pos + 2) << 16) | (this.byteEm(pos + 3) << 24)) >>>
      0
    );
  }

  private copiar(pos: number, n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    this.copiarPara(out, pos, n);
    return out;
  }

  /** Copia `n` bytes a partir de `pos` do pendente para `destino`, pedaço a pedaço. */
  private copiarPara(destino: Uint8Array, pos: number, n: number): void {
    let p = this.inicio + pos;
    let escrito = 0;
    for (const b of this.pedacos) {
      if (escrito >= n) break;
      if (p >= b.length) {
        p -= b.length;
        continue;
      }
      const fatia = Math.min(n - escrito, b.length - p);
      destino.set(b.subarray(p, p + fatia), escrito);
      escrito += fatia;
      p = 0;
    }
  }

  /** Avança o início do pendente em `n` bytes, soltando os pedaços inteiramente consumidos. */
  private consumir(n: number): void {
    this.total -= n;
    this.tamanho = -1;
    let resto = n;
    let soltos = 0;
    while (resto > 0) {
      const b = this.pedacos[soltos];
      if (b === undefined) break;
      const disponivel = b.length - this.inicio;
      if (resto >= disponivel) {
        soltos += 1;
        this.inicio = 0;
        resto -= disponivel;
      } else {
        this.inicio += resto;
        resto = 0;
      }
    }
    if (soltos > 0) this.pedacos.splice(0, soltos);
  }
}
