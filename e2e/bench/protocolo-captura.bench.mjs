/**
 * `LeitorDoProtocolo` (apps/desktop/d0/protocolo-captura.mjs) — `Buffer.concat`
 * a cada pedaço — contra um leitor que acumula pedaços numa lista e só copia
 * quando a mensagem está completa.
 *
 * O cano do `tela-captura` entrega pedaços de tamanho arbitrário. Hoje, a cada
 * pedaço que NÃO completa a mensagem, `pendente` é concatenado de novo: uma
 * mensagem de B bytes que chega em pedaços de c bytes custa
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

/* ─────────────────────────── a alternativa: lista de pedaços + offset ─────────────────────────── */

const QUADRO = 1;
const EVENTO = 2;
const CAPTURA = 3;
const CABECALHO_DO_QUADRO = 9;

/**
 * Mesmo protocolo, sem reconcatenar: guarda os pedaços numa lista e o total
 * pendente; só quando `total >= 4 + tamanho` monta a mensagem — e aí copia
 * exatamente UMA vez, direto para o `ArrayBuffer` que vai ser transferido.
 * Cada byte do cano é copiado no máximo uma vez. O cabeçalho de 4 bytes pode
 * cair na fronteira entre pedaços; `lerU32` trata isso sem concatenar.
 */
class LeitorEmLista {
  constructor(saidas) {
    this.saidas = saidas;
    this.pedacos = [];
    this.inicio = 0; // offset consumido dentro de pedacos[0]
    this.total = 0;
    this.bytesCopiados = 0;
  }
  receber(pedaco) {
    this.pedacos.push(pedaco);
    this.total += pedaco.length;
    for (;;) {
      if (this.total < 4) return;
      const tamanho = this.lerU32(0);
      if (this.total < 4 + tamanho) return;
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
        try {
          this.saidas.evento(JSON.parse(this.copiar(5, tamanho - 1).toString('utf8')));
        } catch {
          // ilegível
        }
      }
      this.consumir(4 + tamanho);
    }
  }
  byteEm(pos) {
    let p = this.inicio + pos;
    for (const b of this.pedacos) {
      if (p < b.length) return b[p];
      p -= b.length;
    }
    throw new Error('fora');
  }
  lerU32(pos) {
    // Caminho rápido: os 4 bytes no primeiro pedaço.
    const b0 = this.pedacos[0];
    if (this.inicio + pos + 4 <= b0.length) return b0.readUInt32LE(this.inicio + pos);
    return this.byteEm(pos) | (this.byteEm(pos + 1) << 8) | (this.byteEm(pos + 2) << 16) | ((this.byteEm(pos + 3) << 24) >>> 0);
  }
  copiar(pos, n) {
    const out = Buffer.allocUnsafe(n);
    this.copiarPara(out, pos, n);
    return out;
  }
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
      destino.set(b.subarray(p, p + fatia), escrito);
      this.bytesCopiados += fatia;
      escrito += fatia;
      p = 0;
    }
  }
  consumir(n) {
    this.total -= n;
    let resto = n;
    while (resto > 0) {
      const b = this.pedacos[0];
      const disponivel = b.length - this.inicio;
      if (resto >= disponivel) {
        this.pedacos.shift();
        this.inicio = 0;
        resto -= disponivel;
      } else {
        this.inicio += resto;
        resto = 0;
      }
    }
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

/* ─────────────────────────── instrumentação de cópia do leitor atual ─────────────────────────── */

/** Conta os bytes que `Buffer.concat` e `slice` copiam no leitor atual, sem mudá-lo. */
function copiasDoAtual(pedacos) {
  const original = Buffer.concat;
  const originalSlice = ArrayBuffer.prototype.slice;
  let copiados = 0;
  Buffer.concat = (lista) => {
    for (const b of lista) copiados += b.length;
    return original(lista);
  };
  ArrayBuffer.prototype.slice = function (a, b) {
    copiados += (b ?? this.byteLength) - (a ?? 0);
    return originalSlice.call(this, a, b);
  };
  try {
    const leitor = new LeitorDoProtocolo({ quadro: () => undefined, evento: () => undefined, captura: () => undefined });
    for (const p of pedacos) leitor.receber(p);
  } finally {
    Buffer.concat = original;
    ArrayBuffer.prototype.slice = originalSlice;
  }
  return copiados;
}

/* ─────────────────────────── medição ─────────────────────────── */

const stream = gerarStream();
cabecalho(`LeitorDoProtocolo — ${SEGUNDOS} s a ${FPS} fps, ${fmt(stream.bytes.length / 1e6, 1)} MB no cano (${stream.quadros} quadros)`);

if (!JSON_SAIDA) {
  console.log('pedaço     atual (ms)   lista (ms)   ganho   copiado atual (MB)   copiado lista (MB)   fator de cópia atual');
}
for (const tamanho of [65_536, 16_384, 4_096, 512]) {
  const pedacos = fragmentar(stream.bytes, tamanho);
  const contar = () => {
    let quadros = 0;
    let bytes = 0;
    return {
      saidas: { quadro: (q) => { quadros += 1; bytes += q.dados.byteLength; }, evento: () => undefined, captura: () => undefined },
      fim: () => ({ quadros, bytes }),
    };
  };
  const ma = medir(() => {
    const c = contar();
    const leitor = new LeitorDoProtocolo(c.saidas);
    for (const p of pedacos) leitor.receber(p);
    return c.fim();
  });
  let listaCopiados = 0;
  const mb = medir(() => {
    const c = contar();
    const leitor = new LeitorEmLista(c.saidas);
    for (const p of pedacos) leitor.receber(p);
    listaCopiados = leitor.bytesCopiados;
    return c.fim();
  });
  if (ma.sentinela.quadros !== stream.quadros || mb.sentinela.quadros !== stream.quadros || ma.sentinela.bytes !== mb.sentinela.bytes) {
    console.error('os dois leitores não devolveram os mesmos quadros', ma.sentinela, mb.sentinela);
    process.exit(1);
  }
  const atualCopiados = copiasDoAtual(pedacos);
  if (!JSON_SAIDA) {
    console.log(
      `${String(tamanho).padStart(6)} B   ${fmt(ma.medianaMs).padStart(9)}   ${fmt(mb.medianaMs).padStart(9)}   ` +
        `${fmt(ma.medianaMs / mb.medianaMs, 1).padStart(4)}×   ${fmt(atualCopiados / 1e6, 1).padStart(17)}   ` +
        `${fmt(listaCopiados / 1e6, 1).padStart(17)}   ${fmt(atualCopiados / stream.bytesUteis, 1).padStart(10)}×`,
    );
  }
  linha({ bench: 'protocolo-captura', pedacoBytes: tamanho, atualMs: ma.medianaMs, listaMs: mb.medianaMs, atualCopiadoBytes: atualCopiados, listaCopiadoBytes: listaCopiados, bytesUteis: stream.bytesUteis });
}

/* ─────────────────────────── pior caso isolado: um IDR grande em pedaços pequenos ─────────────────────────── */

if (!JSON_SAIDA) console.log('\num único IDR de 300 KB (1080p60 em cena complexa) em pedaços de 512 B:');
{
  const cab = Buffer.alloc(9);
  cab[0] = 1;
  const msg = mensagem(QUADRO, cab, Buffer.alloc(300_000, 1));
  const pedacos = fragmentar(msg, 512);
  const ma = medir(() => {
    const leitor = new LeitorDoProtocolo({ quadro: () => undefined, evento: () => undefined });
    for (const p of pedacos) leitor.receber(p);
    return leitor;
  });
  const mb = medir(() => {
    const leitor = new LeitorEmLista({ quadro: () => undefined, evento: () => undefined });
    for (const p of pedacos) leitor.receber(p);
    return leitor;
  });
  const copiados = copiasDoAtual(pedacos);
  if (!JSON_SAIDA) {
    console.log(`  atual: ${fmt(ma.medianaMs)} ms, ${fmt(copiados / 1e6, 1)} MB copiados para 0,3 MB úteis (${fmt(copiados / 300_000, 0)}×)`);
    console.log(`  lista: ${fmt(mb.medianaMs)} ms, ${fmt(mb.sentinela.bytesCopiados / 1e6, 2)} MB copiados`);
  }
  linha({ bench: 'protocolo-captura/idr-300k-512', atualMs: ma.medianaMs, listaMs: mb.medianaMs, atualCopiadoBytes: copiados });
}
