/**
 * Leitor do protocolo de saída do `tela-captura` (nativo/linux/tela-captura.c):
 *
 *   [u32 LE tamanho][u8 tipo][corpo de tamanho-1 bytes]
 *     tipo 1, quadro: [u8 chave][u16 LE largura][u16 LE altura][u32 LE seq][H.264 Annex B]
 *     tipo 2, evento: JSON UTF-8
 *     tipo 3, captura: sem corpo — quadro capturado e descartado (relógio da isca)
 *
 * O cano entrega pedaços arbitrários; isto remonta as mensagens.
 */
const QUADRO = 1;
const EVENTO = 2;
const CAPTURA = 3;
const CABECALHO_DO_QUADRO = 9;

export class LeitorDoProtocolo {
  /** @param {{ quadro: (q: {chave: boolean, width: number, height: number, seq: number, dados: ArrayBuffer}) => void, evento: (e: any) => void, captura?: () => void }} saidas */
  constructor(saidas) {
    this.saidas = saidas;
    this.pendente = Buffer.alloc(0);
  }

  /** @param {Buffer} pedaco */
  receber(pedaco) {
    this.pendente = this.pendente.length === 0 ? pedaco : Buffer.concat([this.pendente, pedaco]);
    let p = 0;
    while (this.pendente.length - p >= 4) {
      const tamanho = this.pendente.readUInt32LE(p);
      if (this.pendente.length - p - 4 < tamanho) break;
      const tipo = this.pendente[p + 4];
      const corpo = this.pendente.subarray(p + 5, p + 4 + tamanho);
      p += 4 + tamanho;
      if (tipo === QUADRO && corpo.length >= CABECALHO_DO_QUADRO) {
        const h264 = corpo.subarray(CABECALHO_DO_QUADRO);
        // Cópia própria: o ArrayBuffer vai ser transferido para o worker.
        const dados = h264.buffer.slice(h264.byteOffset, h264.byteOffset + h264.length);
        this.saidas.quadro({
          chave: corpo[0] === 1,
          width: corpo.readUInt16LE(1),
          height: corpo.readUInt16LE(3),
          seq: corpo.readUInt32LE(5),
          dados,
        });
      } else if (tipo === CAPTURA) {
        this.saidas.captura?.();
      } else if (tipo === EVENTO) {
        try {
          this.saidas.evento(JSON.parse(corpo.toString('utf8')));
        } catch {
          // Evento ilegível não derruba a transmissão.
        }
      }
    }
    this.pendente = p === this.pendente.length ? Buffer.alloc(0) : this.pendente.subarray(p);
  }
}
