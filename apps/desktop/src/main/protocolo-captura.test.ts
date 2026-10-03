import { describe, expect, it } from 'vitest';
import { LeitorDoProtocolo, TAMANHO_MAXIMO_DA_MENSAGEM, type EventoDoNativo, type QuadroDoNativo } from './protocolo-captura.js';

/**
 * `LeitorDoProtocolo` contra uma decodificação de referência, com o mesmo
 * stream fatiado em pedaços de tamanho aleatório — o cano do `tela-captura`
 * corta onde quer, inclusive no meio do cabeçalho de 4 bytes.
 */
const QUADRO = 1;
const EVENTO = 2;
const CAPTURA = 3;

/** mulberry32: determinístico, para o teste ser reproduzível por semente. */
function rng(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mensagem(tipo: number, corpo: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h.writeUInt32LE(1 + corpo.length, 0);
  h[4] = tipo;
  return Buffer.concat([h, corpo]);
}

function quadro(
  r: () => number,
  seq: number,
  { chave = r() < 0.1, bytes = Math.floor(r() * 40_000), maximoDeBytes = 40_000 } = {},
): Buffer {
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
function gerarStream(semente: number, mensagens: number, maximoDeBytes: number): Buffer {
  const r = rng(semente);
  const partes: Buffer[] = [];
  let seq = 0;
  for (let i = 0; i < mensagens; i += 1) {
    const sorteio = r();
    if (sorteio < 0.7) partes.push(quadro(r, seq++, { maximoDeBytes }));
    else if (sorteio < 0.75) partes.push(quadro(r, seq++, { bytes: 0 }));
    else if (sorteio < 0.85) partes.push(mensagem(CAPTURA, Buffer.alloc(0)));
    else if (sorteio < 0.9)
      partes.push(mensagem(EVENTO, Buffer.from(JSON.stringify({ evento: 'stats', msPorQuadro: r() * 10, i }))));
    else if (sorteio < 0.93) partes.push(mensagem(EVENTO, Buffer.from('[1,2]'))); // JSON, mas não objeto: ignorado
    else if (sorteio < 0.96) partes.push(mensagem(EVENTO, Buffer.from('{não é json'))); // ignorado
    else if (sorteio < 0.98) partes.push(mensagem(QUADRO, Buffer.alloc(Math.floor(r() * 9)))); // curto: ignorado
    else partes.push(mensagem(9, Buffer.alloc(Math.floor(r() * 100)))); // tipo desconhecido: ignorado
  }
  return Buffer.concat(partes);
}

type Saida =
  | { tipo: 'quadro'; chave: boolean; width: number; height: number; seq: number; dados: string }
  | { tipo: 'captura' }
  | { tipo: 'evento'; evento: EventoDoNativo };

/** Decodificação de referência: o stream inteiro, de uma vez, sem fragmentação. */
function referencia(bytes: Buffer): Saida[] {
  const saida: Saida[] = [];
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
        const e: unknown = JSON.parse(corpo.toString('utf8'));
        if (typeof e === 'object' && e !== null && !Array.isArray(e)) saida.push({ tipo: 'evento', evento: e as EventoDoNativo });
      } catch {
        // ignorado
      }
    }
  }
  return saida;
}

function coletor() {
  const saida: Saida[] = [];
  const leitor = new LeitorDoProtocolo({
    quadro: (q) => {
      expect(q.dados).toBeInstanceOf(ArrayBuffer);
      saida.push({ tipo: 'quadro', chave: q.chave, width: q.width, height: q.height, seq: q.seq, dados: Buffer.from(q.dados).toString('hex') });
    },
    evento: (e) => saida.push({ tipo: 'evento', evento: e }),
    captura: () => saida.push({ tipo: 'captura' }),
  });
  return { leitor, saida };
}

function fragmentar(bytes: Buffer, r: () => number, maximo: number): Buffer[] {
  const pedacos: Buffer[] = [];
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
  { mensagens: 200, maximoDeBytes: 40_000, maximos: [512, 4_096, 65_536, 200_000] },
];

describe('LeitorDoProtocolo', () => {
  it('fragmentação aleatória reproduz a decodificação de referência', () => {
    for (let semente = 1; semente <= 6; semente += 1) {
      for (const { mensagens, maximoDeBytes, maximos } of FRAGMENTACOES) {
        const bytes = gerarStream(semente, mensagens, maximoDeBytes);
        const esperado = referencia(bytes);
        expect(esperado.filter((m) => m.tipo === 'quadro').length).toBeGreaterThan(mensagens / 3);
        for (const maximo of maximos) {
          const r = rng(semente * 1000 + maximo);
          const { leitor, saida } = coletor();
          for (const pedaco of fragmentar(bytes, r, maximo)) leitor.receber(pedaco);
          expect(saida, `semente ${semente}, pedaços até ${maximo} B`).toEqual(esperado);
          expect(leitor.pendente).toBe(0);
        }
      }
    }
  });

  it('o cabeçalho de 4 bytes partido em pedaços de 1 byte', () => {
    const bytes = Buffer.concat([quadro(rng(1), 7, { chave: true, bytes: 10 }), mensagem(CAPTURA, Buffer.alloc(0))]);
    const { leitor, saida } = coletor();
    for (let i = 0; i < bytes.length; i += 1) leitor.receber(bytes.subarray(i, i + 1));
    expect(saida).toEqual(referencia(bytes));
  });

  it('várias mensagens num pedaço só, e um pedaço vazio no meio', () => {
    const r = rng(5);
    const bytes = Buffer.concat([quadro(r, 1), quadro(r, 2), mensagem(CAPTURA, Buffer.alloc(0)), quadro(r, 3)]);
    const { leitor, saida } = coletor();
    leitor.receber(bytes.subarray(0, 10));
    leitor.receber(Buffer.alloc(0));
    leitor.receber(bytes.subarray(10));
    expect(saida).toEqual(referencia(bytes));
  });

  it('o ArrayBuffer do quadro é do quadro: mexer no pedaço de origem depois não o altera', () => {
    const r = rng(9);
    const bytes = Buffer.from(quadro(r, 42, { bytes: 1000 }));
    const recebidos: QuadroDoNativo[] = [];
    const leitor = new LeitorDoProtocolo({ quadro: (q) => recebidos.push(q), evento: () => undefined });
    leitor.receber(bytes.subarray(0, 300));
    leitor.receber(bytes.subarray(300));
    expect(recebidos).toHaveLength(1);
    const antes = Buffer.from(recebidos[0]!.dados).toString('hex');
    bytes.fill(0xff);
    expect(Buffer.from(recebidos[0]!.dados).toString('hex')).toBe(antes);
    expect(recebidos[0]!.dados.byteLength).toBe(1000);
    expect(recebidos[0]!.seq).toBe(42);
  });

  it('mensagem incompleta fica pendente até o resto chegar', () => {
    const bytes = quadro(rng(2), 3, { bytes: 5000 });
    const { leitor, saida } = coletor();
    leitor.receber(bytes.subarray(0, 4999));
    expect(saida).toHaveLength(0);
    expect(leitor.pendente).toBe(4999);
    leitor.receber(bytes.subarray(4999));
    expect(saida).toHaveLength(1);
    expect(leitor.pendente).toBe(0);
  });

  it('tamanho zero (fora do protocolo) é pulado sem travar nem desalinhar', () => {
    const bytes = Buffer.concat([Buffer.alloc(4), quadro(rng(3), 1, { bytes: 10 })]);
    const { leitor, saida } = coletor();
    leitor.receber(bytes);
    expect(saida).toHaveLength(1);
    expect(saida[0]).toMatchObject({ tipo: 'quadro', seq: 1 });
  });

  it('comprimento acima do teto: avisa corrompido e para de ler (sem acumular memória)', () => {
    let corrompido = 0;
    const quadros: unknown[] = [];
    const leitor = new LeitorDoProtocolo({ quadro: (q) => quadros.push(q), evento: () => undefined, corrompido: () => (corrompido += 1) });
    const cabecalho = Buffer.alloc(4);
    cabecalho.writeUInt32LE(TAMANHO_MAXIMO_DA_MENSAGEM + 1, 0);
    leitor.receber(cabecalho);
    leitor.receber(Buffer.alloc(1024));
    expect(corrompido).toBe(1);
    expect(leitor.pendente).toBe(0);
    expect(quadros).toEqual([]);
  });
});
