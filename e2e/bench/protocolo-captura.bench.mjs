/**
 * `LeitorDoProtocolo` de hoje (apps/desktop/d0/protocolo-captura.mjs — lista
 * de pedaços + offset, cada byte copiado uma vez) contra a versão anterior
 * (`Buffer.concat` a cada pedaço), que vive só aqui como "antes" (A4 do
 * docs/engenharia/complexidade.md).
 *
 * O cano do `tela-captura` entrega pedaços de tamanho arbitrário. Na anterior,
 * a cada pedaço que NÃO completava a mensagem, `pendente` era concatenado de
 * novo: uma mensagem de B bytes chegando em pedaços de c bytes custava
 * ~B²/(2c) bytes de cópia em vez de B. Com um IDR de 150 KB em pedaços de
 * 4 KB são ~2,8 MB copiados para 150 KB úteis.
 *
 * O stream é o mesmo para os dois: 10 s a 60 fps, quadros P de ~25 KB (12 Mbps)
 * e um IDR de ~150 KB a cada 2 s, mais um evento `stats` por segundo e um
 * `captura` a cada 10 quadros. A fragmentação varia: 64 KiB (o `highWaterMark`
 * de um pipe no Node), 16 KiB, 4 KiB (PIPE_BUF típico quando o leitor está
 * atrasado) e 512 B (pior caso, para ver a curva).
 *
 *   node e2e/bench/protocolo-captura.bench.mjs
 */
import { RAIZ, cabecalho, medir, fmt, linha, rng, JSON_SAIDA } from './comum.mjs';
import { join } from 'node:path';

const { LeitorDoProtocolo } = await import(join(RAIZ, 'apps/desktop/d0/protocolo-captura.mjs'));

/* ─────────────────────────── a anterior: Buffer.concat por pedaço ─────────────────────────── */

const QUADRO = 1;
const EVENTO = 2;
const CAPTURA = 3;
const CABECALHO_DO_QUADRO = 9;

/** O leitor como era: `pendente = Buffer.concat([pendente, pedaço])` a cada pedaço. */
class LeitorConcat {
  constructor(saidas) {
    this.saidas = saidas;
    this.pendente = Buffer.alloc(0);
  }
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
          // ilegível
        }
      }
    }
    this.pendente = p === this.pendente.length ? Buffer.alloc(0) : this.pendente.subarray(p);
  }
}

/* ─────────────────────────── o stream ─────────────────────────── */

const FPS = 60;
const SEGUNDOS = 10;

function mensagem(tipo, cabecalho, corpo) {
  const h = Buffer.alloc(5);
  h.writeUInt32LE(1 + cabecalho.length + corpo.length, 0);
  h[4] = tipo;
  return Buffer.concat([h, cabecalho, corpo]);
}

function gerarStream(semente = 3) {
  const r = rng(semente);
  const partes = [];
  let seq = 0;
  let bytesUteis = 0;
  for (let q = 0; q < FPS * SEGUNDOS; q += 1) {
    const chave = q % 120 === 0;
    const n = chave ? 150_000 + Math.floor(r() * 20_000) : 20_000 + Math.floor(r() * 10_000);
    const cab = Buffer.alloc(9);
    cab[0] = chave ? 1 : 0;
    cab.writeUInt16LE(1920, 1);
    cab.writeUInt16LE(1080, 3);
    cab.writeUInt32LE(seq++, 5);
    const corpo = Buffer.alloc(n, 0x5a);
    bytesUteis += n;
    partes.push(mensagem(QUADRO, cab, corpo));
    if (q % 10 === 0) partes.push(mensagem(CAPTURA, Buffer.alloc(0), Buffer.alloc(0)));
    if (q % FPS === 0) partes.push(mensagem(EVENTO, Buffer.alloc(0), Buffer.from(JSON.stringify({ evento: 'stats', msPorQuadro: 4.2, descartados: 0 }))));
  }
  return { bytes: Buffer.concat(partes), quadros: seq, bytesUteis };
}

function fragmentar(bytes, tamanho) {
  const out = [];
  for (let p = 0; p < bytes.length; p += tamanho) out.push(bytes.subarray(p, p + tamanho));
  return out;
}

/* ─────────────────────────── instrumentação de cópia ─────────────────────────── */

/**
 * Conta os bytes que cada leitor copia, sem mudá-lo: a anterior copia por
 * `Buffer.concat` e `ArrayBuffer.slice`; a atual, por `Buffer.copy`.
 */
function contarCopias(criar, pedacos) {
  const concat = Buffer.concat;
  const slice = ArrayBuffer.prototype.slice;
  const copy = Buffer.prototype.copy;
  let copiados = 0;
  Buffer.concat = (lista) => {
    for (const b of lista) copiados += b.length;
    return concat(lista);
  };
  ArrayBuffer.prototype.slice = function (a, b) {
    copiados += (b ?? this.byteLength) - (a ?? 0);
    return slice.call(this, a, b);
  };
  Buffer.prototype.copy = function (destino, inicioDestino, inicio, fim) {
    copiados += (fim ?? this.length) - (inicio ?? 0);
    return copy.call(this, destino, inicioDestino, inicio, fim);
  };
  try {
    const leitor = criar({ quadro: () => undefined, evento: () => undefined, captura: () => undefined });
    for (const p of pedacos) leitor.receber(p);
  } finally {
    Buffer.concat = concat;
    ArrayBuffer.prototype.slice = slice;
    Buffer.prototype.copy = copy;
  }
  return copiados;
}

/* ─────────────────────────── medição ─────────────────────────── */

const stream = gerarStream();
cabecalho(`LeitorDoProtocolo — ${SEGUNDOS} s a ${FPS} fps, ${fmt(stream.bytes.length / 1e6, 1)} MB no cano (${stream.quadros} quadros)`);

if (!JSON_SAIDA) {
  console.log('pedaço     anterior (ms)   atual (ms)   ganho   copiado anterior (MB)   copiado atual (MB)   fator de cópia anterior');
}
for (const tamanho of [65_536, 16_384, 4_096, 512]) {
  const pedacos = fragmentar(stream.bytes, tamanho);
  const contar = () => {
    let quadros = 0;
    let bytes = 0;
    let soma = 0;
    return {
      saidas: {
        quadro: (q) => {
          quadros += 1;
          bytes += q.dados.byteLength;
          soma += q.seq + new Uint8Array(q.dados)[0];
        },
        evento: () => undefined,
        captura: () => undefined,
      },
      fim: () => ({ quadros, bytes, soma }),
    };
  };
  const ma = medir(() => {
    const c = contar();
    const leitor = new LeitorConcat(c.saidas);
    for (const p of pedacos) leitor.receber(p);
    return c.fim();
  });
  const mb = medir(() => {
    const c = contar();
    const leitor = new LeitorDoProtocolo(c.saidas);
    for (const p of pedacos) leitor.receber(p);
    return c.fim();
  });
  if (
    ma.sentinela.quadros !== stream.quadros ||
    mb.sentinela.quadros !== stream.quadros ||
    ma.sentinela.bytes !== mb.sentinela.bytes ||
    ma.sentinela.soma !== mb.sentinela.soma
  ) {
    console.error('os dois leitores não devolveram os mesmos quadros', ma.sentinela, mb.sentinela);
    process.exit(1);
  }
  const anteriorCopiados = contarCopias((s) => new LeitorConcat(s), pedacos);
  const atualCopiados = contarCopias((s) => new LeitorDoProtocolo(s), pedacos);
  if (!JSON_SAIDA) {
    console.log(
      `${String(tamanho).padStart(6)} B   ${fmt(ma.medianaMs).padStart(12)}   ${fmt(mb.medianaMs).padStart(9)}   ` +
        `${fmt(ma.medianaMs / mb.medianaMs, 1).padStart(4)}×   ${fmt(anteriorCopiados / 1e6, 1).padStart(20)}   ` +
        `${fmt(atualCopiados / 1e6, 1).padStart(17)}   ${fmt(anteriorCopiados / stream.bytesUteis, 1).padStart(10)}×`,
    );
  }
  linha({ bench: 'protocolo-captura', pedacoBytes: tamanho, anteriorMs: ma.medianaMs, atualMs: mb.medianaMs, anteriorCopiadoBytes: anteriorCopiados, atualCopiadoBytes: atualCopiados, bytesUteis: stream.bytesUteis });
}

/* ─────────────────────────── pior caso isolado: um IDR grande em pedaços pequenos ─────────────────────────── */

if (!JSON_SAIDA) console.log('\num único IDR de 300 KB (1080p60 em cena complexa) em pedaços de 512 B:');
{
  const cab = Buffer.alloc(9);
  cab[0] = 1;
  const msg = mensagem(QUADRO, cab, Buffer.alloc(300_000, 1));
  const pedacos = fragmentar(msg, 512);
  const ma = medir(() => {
    const leitor = new LeitorConcat({ quadro: () => undefined, evento: () => undefined });
    for (const p of pedacos) leitor.receber(p);
    return leitor;
  });
  const mb = medir(() => {
    const leitor = new LeitorDoProtocolo({ quadro: () => undefined, evento: () => undefined });
    for (const p of pedacos) leitor.receber(p);
    return leitor;
  });
  const anteriorCopiados = contarCopias((s) => new LeitorConcat(s), pedacos);
  const atualCopiados = contarCopias((s) => new LeitorDoProtocolo(s), pedacos);
  if (!JSON_SAIDA) {
    console.log(`  anterior: ${fmt(ma.medianaMs)} ms, ${fmt(anteriorCopiados / 1e6, 1)} MB copiados para 0,3 MB úteis (${fmt(anteriorCopiados / 300_000, 0)}×)`);
    console.log(`  atual:    ${fmt(mb.medianaMs)} ms, ${fmt(atualCopiados / 1e6, 2)} MB copiados`);
  }
  linha({ bench: 'protocolo-captura/idr-300k-512', anteriorMs: ma.medianaMs, atualMs: mb.medianaMs, anteriorCopiadoBytes: anteriorCopiados, atualCopiadoBytes: atualCopiados });
}
