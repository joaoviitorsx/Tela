/**
 * Leitor do protocolo de saída do `tela-captura` (nativo/linux/tela-captura.c):
 *
 *   [u32 LE tamanho][u8 tipo][corpo de tamanho-1 bytes]
 *     tipo 1, quadro: [u8 chave][u16 LE largura][u16 LE altura][u32 LE seq][H.264 Annex B]
 *     tipo 2, evento: JSON UTF-8
 *     tipo 3, captura: sem corpo — quadro capturado e descartado (relógio da isca)
 *
 * O cano entrega pedaços arbitrários; isto remonta as mensagens.
 *
 * Os pedaços ficam numa lista até a mensagem estar completa; só então cada
 * byte é copiado, UMA vez, direto para o `ArrayBuffer` que vai ser
 * transferido. A versão anterior fazia `Buffer.concat` a cada pedaço que não
 * completava a mensagem — O(B²/c) por mensagem: um IDR de 300 KB em pedaços
 * de 512 B copiava 88 MB (docs/engenharia/complexidade.md, A4).
 */
const QUADRO = 1;
const EVENTO = 2;
const CAPTURA = 3;
const CABECALHO_DO_QUADRO = 9;

export class LeitorDoProtocolo {
  /** @param {{ quadro: (q: {chave: boolean, width: number, height: number, seq: number, dados: ArrayBuffer}) => void, evento: (e: any) => void, captura?: () => void }} saidas */
  constructor(saidas) {
    this.saidas = saidas;
    /** @type {Buffer[]} pedaços ainda não consumidos, do mais velho para o mais novo */
    this.pedacos = [];
    /** Quanto do primeiro pedaço já foi consumido. */
    this.inicio = 0;
    /** Bytes pendentes no total (soma dos pedaços menos `inicio`). */
    this.total = 0;
    /**
     * Tamanho da mensagem na cabeça, lido uma vez; -1 enquanto o cabeçalho não
     * chegou. Sem isto, cada pedaço que não completa a mensagem relia o
     * cabeçalho andando a lista — O(pedaços) por pedaço, quadrático de novo.
     */
    this.tamanho = -1;
  }

  /** @param {Buffer} pedaco */
  receber(pedaco) {
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
        // Cópia própria: o ArrayBuffer vai ser transferido para o worker.
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
        try {
          this.saidas.evento(JSON.parse(this.copiar(5, tamanho - 1).toString('utf8')));
        } catch {
          // Evento ilegível não derruba a transmissão.
        }
      }
      this.consumir(4 + tamanho);
    }
  }

  /** O byte na posição `pos` do pendente (pode cair em qualquer pedaço). */
  byteEm(pos) {
    let p = this.inicio + pos;
    for (const b of this.pedacos) {
      if (p < b.length) return b[p];
      p -= b.length;
    }
    throw new Error('leitor do protocolo: posição fora do pendente');
  }

  lerU32(pos) {
    // Caminho normal: os 4 bytes no primeiro pedaço. Na fronteira, byte a byte.
    const b0 = this.pedacos[0];
    if (this.inicio + pos + 4 <= b0.length) return b0.readUInt32LE(this.inicio + pos);
    return (this.byteEm(pos) | (this.byteEm(pos + 1) << 8) | (this.byteEm(pos + 2) << 16) | (this.byteEm(pos + 3) << 24)) >>> 0;
  }

  copiar(pos, n) {
    const out = Buffer.allocUnsafe(n);
    this.copiarPara(out, pos, n);
    return out;
  }

  /** Copia `n` bytes a partir de `pos` do pendente para `destino`, pedaço a pedaço. */
  copiarPara(destino, pos, n) {
    let p = this.inicio + pos;
    let escrito = 0;
    for (const b of this.pedacos) {
      if (escrito >= n) break;
      if (p >= b.length) {
        p -= b.length;
        continue;
      }
      const fatia = Math.min(n - escrito, b.length - p);
      b.copy(destino, escrito, p, p + fatia);
      escrito += fatia;
      p = 0;
    }
  }

  /** Avança o início do pendente em `n` bytes, soltando os pedaços inteiramente consumidos. */
  consumir(n) {
    this.total -= n;
    this.tamanho = -1;
    let resto = n;
    let soltos = 0;
    while (resto > 0) {
      const b = this.pedacos[soltos];
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
