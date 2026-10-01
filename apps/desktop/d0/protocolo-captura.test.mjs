/**
 * `LeitorDoProtocolo` contra uma decodificação de referência, com o mesmo
 * stream fatiado em pedaços de tamanho aleatório — o cano do `tela-captura`
 * corta onde quer, inclusive no meio do cabeçalho de 4 bytes.
 *
 *   node --test apps/desktop/d0/protocolo-captura.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeitorDoProtocolo } from './protocolo-captura.mjs';

const QUADRO = 1;
const EVENTO = 2;
const CAPTURA = 3;

/** mulberry32: determinístico, para o teste ser reproduzível por semente. */
function rng(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mensagem(tipo, corpo) {
  const h = Buffer.alloc(5);
  h.writeUInt32LE(1 + corpo.length, 0);
  h[4] = tipo;
  return Buffer.concat([h, corpo]);
}

function quadro(r, seq, { chave = r() < 0.1, bytes = Math.floor(r() * 40_000), maximoDeBytes = 40_000 } = {}) {
  bytes = Math.min(bytes, maximoDeBytes);
  const cab = Buffer.alloc(9);
  cab[0] = chave ? 1 : 0;
  cab.writeUInt16LE(1920, 1);
  cab.writeUInt16LE(1080, 3);
  cab.writeUInt32LE(seq, 5);
  const h264 = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) h264[i] = (seq + i) & 0xff;
  return mensagem(QUADRO, Buffer.concat([cab, h264]));
}

/** Um stream com de tudo: quadros (alguns vazios), eventos, capturas, lixo. */
function gerarStream(semente, mensagens, maximoDeBytes) {
  const r = rng(semente);
  const partes = [];
  let seq = 0;
  for (let i = 0; i < mensagens; i += 1) {
    const sorteio = r();
    if (sorteio < 0.7) partes.push(quadro(r, seq++, { maximoDeBytes }));
    else if (sorteio < 0.75) partes.push(quadro(r, seq++, { bytes: 0 })); // quadro sem H.264: cabeçalho só
    else if (sorteio < 0.85) partes.push(mensagem(CAPTURA, Buffer.alloc(0)));
    else if (sorteio < 0.93) partes.push(mensagem(EVENTO, Buffer.from(JSON.stringify({ evento: 'stats', msPorQuadro: r() * 10, i }))));
    else if (sorteio < 0.96) partes.push(mensagem(EVENTO, Buffer.from('{não é json'))); // ignorado
    else if (sorteio < 0.98) partes.push(mensagem(QUADRO, Buffer.alloc(Math.floor(r() * 9)))); // quadro curto: ignorado
    else partes.push(mensagem(9, Buffer.alloc(Math.floor(r() * 100)))); // tipo desconhecido: ignorado
  }
  return Buffer.concat(partes);
}

/** Decodificação de referência: o stream inteiro, de uma vez, sem fragmentação. */
function referencia(bytes) {
  const saida = [];
  let p = 0;
  while (bytes.length - p >= 4) {
    const tamanho = bytes.readUInt32LE(p);
    if (bytes.length - p - 4 < tamanho) break;
    const tipo = bytes[p + 4];
    const corpo = bytes.subarray(p + 5, p + 4 + tamanho);
    p += 4 + tamanho;
    if (tipo === QUADRO && corpo.length >= 9) {
      saida.push({
        tipo: 'quadro',
        chave: corpo[0] === 1,
        width: corpo.readUInt16LE(1),
        height: corpo.readUInt16LE(3),
        seq: corpo.readUInt32LE(5),
        dados: Buffer.from(corpo.subarray(9)).toString('hex'),
      });
    } else if (tipo === CAPTURA) {
      saida.push({ tipo: 'captura' });
    } else if (tipo === EVENTO) {
      try {
        saida.push({ tipo: 'evento', evento: JSON.parse(corpo.toString('utf8')) });
      } catch {
        // ignorado
      }
    }
  }
  return saida;
}

function coletor() {
  const saida = [];
  const leitor = new LeitorDoProtocolo({
    quadro: (q) => {
      assert.ok(q.dados instanceof ArrayBuffer, 'dados deve ser um ArrayBuffer próprio');
      saida.push({ tipo: 'quadro', chave: q.chave, width: q.width, height: q.height, seq: q.seq, dados: Buffer.from(q.dados).toString('hex') });
    },
    evento: (e) => saida.push({ tipo: 'evento', evento: e }),
    captura: () => saida.push({ tipo: 'captura' }),
  });
  return { leitor, saida };
}

function fragmentar(bytes, r, maximo) {
  const pedacos = [];
  let p = 0;
  while (p < bytes.length) {
    const n = 1 + Math.floor(r() * maximo);
    pedacos.push(bytes.subarray(p, p + n));
    p += n;
  }
  return pedacos;
}

/** Pedaços minúsculos num stream pequeno; pedaços realistas num stream com quadros de verdade. */
const FRAGMENTACOES = [
  { mensagens: 60, maximoDeBytes: 1_500, maximos: [1, 2, 3, 7, 64] },
  { mensagens: 300, maximoDeBytes: 40_000, maximos: [512, 4_096, 65_536, 200_000] },
];

test('fragmentação aleatória reproduz a decodificação de referência (vários tamanhos, várias sementes)', () => {
  for (let semente = 1; semente <= 8; semente += 1) {
    for (const { mensagens, maximoDeBytes, maximos } of FRAGMENTACOES) {
      const bytes = gerarStream(semente, mensagens, maximoDeBytes);
      const esperado = referencia(bytes);
      assert.ok(esperado.filter((m) => m.tipo === 'quadro').length > mensagens / 3);
      for (const maximo of maximos) {
        const r = rng(semente * 1000 + maximo);
        const { leitor, saida } = coletor();
        for (const pedaco of fragmentar(bytes, r, maximo)) leitor.receber(pedaco);
        assert.deepEqual(saida, esperado, `semente ${semente}, pedaços até ${maximo} B`);
        assert.equal(leitor.total, 0, 'nada fica pendente no fim de um stream inteiro');
        assert.equal(leitor.pedacos.length, 0);
      }
    }
  }
});

test('o cabeçalho de 4 bytes partido em até quatro pedaços de 1 byte', () => {
  const bytes = Buffer.concat([quadro(rng(1), 7, { chave: true, bytes: 10 }), mensagem(CAPTURA, Buffer.alloc(0))]);
  const esperado = referencia(bytes);
  const { leitor, saida } = coletor();
  for (let i = 0; i < bytes.length; i += 1) leitor.receber(bytes.subarray(i, i + 1));
  assert.deepEqual(saida, esperado);
});

test('várias mensagens num pedaço só, e um pedaço vazio no meio', () => {
  const r = rng(5);
  const bytes = Buffer.concat([quadro(r, 1), quadro(r, 2), mensagem(CAPTURA, Buffer.alloc(0)), quadro(r, 3)]);
  const { leitor, saida } = coletor();
  leitor.receber(bytes.subarray(0, 10));
  leitor.receber(Buffer.alloc(0));
  leitor.receber(bytes.subarray(10));
  assert.deepEqual(saida, referencia(bytes));
});

test('o ArrayBuffer do quadro é do quadro: mexer no pedaço de origem depois não o altera', () => {
  const r = rng(9);
  const bytes = Buffer.from(quadro(r, 42, { bytes: 1000 }));
  const recebidos = [];
  const leitor = new LeitorDoProtocolo({ quadro: (q) => recebidos.push(q), evento: () => undefined });
  leitor.receber(bytes.subarray(0, 300));
  leitor.receber(bytes.subarray(300));
  assert.equal(recebidos.length, 1);
  const antes = Buffer.from(recebidos[0].dados).toString('hex');
  bytes.fill(0xff);
  assert.equal(Buffer.from(recebidos[0].dados).toString('hex'), antes);
  assert.equal(recebidos[0].dados.byteLength, 1000);
  assert.equal(recebidos[0].seq, 42);
});

test('mensagem incompleta fica pendente até o resto chegar', () => {
  const r = rng(2);
  const bytes = quadro(r, 3, { bytes: 5000 });
  const { leitor, saida } = coletor();
  leitor.receber(bytes.subarray(0, 4999));
  assert.equal(saida.length, 0);
  assert.equal(leitor.total, 4999);
  leitor.receber(bytes.subarray(4999));
  assert.equal(saida.length, 1);
  assert.equal(leitor.total, 0);
});

test('tamanho zero (fora do protocolo) é pulado sem travar nem desalinhar', () => {
  const r = rng(3);
  const bytes = Buffer.concat([Buffer.alloc(4), quadro(r, 1, { bytes: 10 })]);
  const { leitor, saida } = coletor();
  leitor.receber(bytes);
  assert.equal(saida.length, 1);
  assert.equal(saida[0].seq, 1);
});
