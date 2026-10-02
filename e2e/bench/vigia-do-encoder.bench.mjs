/**
 * O caminho por quadro do `CodificadorWebCodecs` que é nosso (D9): medir o
 * tempo entrada→saída de cada quadro. Antes, um `Map<timestamp, instante>`
 * com `set`/`get`/`delete` e um `clear()` de segurança acima de 120; agora o
 * `VigiaDoEncoder` (anel de `Float64Array` fixo, O(1), sem alocação), que
 * também acusa a trava do encoder. A anterior vive só aqui, como "antes".
 *
 * Cenário: 10 min a 60 fps; o encoder devolve em ordem com 16 a 34 ms de
 * atraso e pula um quadro a cada 600 (o `realtime` pode pular). Os dois são
 * conferidos: a mesma média de ms por quadro em cada leitura de 1 s, e
 * nenhuma trava acusada num encoder saudável.
 *
 * Cada implementação roda numa CÓPIA própria do laço (`new Function`), para
 * o JIT não misturar as duas num ponto de chamada polimórfico, e um vigia
 * vazio dá a linha de base do próprio laço — que é descontada do tempo e dos
 * bytes. "Bytes alocados" é a variação de `heapUsed` numa execução aquecida,
 * com GC forçado antes: aproximado, mas separa "aloca por quadro" de "não aloca".
 *
 *   node e2e/bench/vigia-do-encoder.bench.mjs
 */
import { sobTsx, W, cabecalho, medir, fmt, linha, rng, JSON_SAIDA } from './comum.mjs';

sobTsx(import.meta.url);

const { VigiaDoEncoder } = await import(W('core/media/vigia-do-encoder.ts'));

/** O de antes, como estava em `webcodecs-codificador.ts`. */
class MapaAnterior {
  constructor() {
    this.entrada = new Map();
    this.somaMs = 0;
    this.amostras = 0;
  }
  reiniciar() {}
  entrou(ts, agora) {
    this.entrada.set(ts, agora);
  }
  saiu(ts, agora) {
    const e = this.entrada.get(ts);
    if (e !== undefined) {
      this.somaMs += agora - e;
      this.amostras += 1;
      this.entrada.delete(ts);
    }
    if (this.entrada.size > 120) this.entrada.clear();
  }
  travou() {
    return false;
  }
  lerMsPorQuadro() {
    const m = this.amostras === 0 ? null : this.somaMs / this.amostras;
    this.somaMs = 0;
    this.amostras = 0;
    return m;
  }
}

/** Linha de base: o laço sem trabalho nenhum. */
class Vazio {
  reiniciar() {}
  entrou() {}
  saiu() {}
  travou() {
    return false;
  }
  lerMsPorQuadro() {
    return null;
  }
}

const FPS = 60;
const SEGUNDOS = 600;
const QUADROS = FPS * SEGUNDOS;

/** Roteiro fixo em arrays tipados: tipo (0 entrou, 1 saiu), carimbo, instante. */
function roteiro() {
  const r = rng(42);
  const eventos = [];
  let ultimaSaida = 0;
  for (let i = 0; i < QUADROS; i++) {
    const t = i * (1000 / FPS);
    eventos.push([0, i * 16_667, t]);
    if (i % 600 === 599) continue; // pulado pelo encoder
    // Sem B-frames, o encoder entrega em ordem: a saída nunca passa a anterior.
    ultimaSaida = Math.max(ultimaSaida + 0.001, t + 16 + r() * 18);
    eventos.push([1, i * 16_667, ultimaSaida]);
  }
  eventos.sort((a, b) => a[2] - b[2] || a[0] - b[0]);
  return {
    n: eventos.length,
    tipo: Uint8Array.from(eventos, (e) => e[0]),
    ts: Float64Array.from(eventos, (e) => e[1]),
    t: Float64Array.from(eventos, (e) => e[2]),
  };
}

const R = roteiro();

const LACO = `return function executar(v, R) {
  v.reiniciar(0);
  const medias = [];
  let proximaLeitura = 1000;
  let travas = 0;
  for (let k = 0; k < R.n; k++) {
    const t = R.t[k];
    if (t >= proximaLeitura) {
      medias.push(v.lerMsPorQuadro());
      proximaLeitura += 1000;
    }
    if (R.tipo[k] === 0) {
      if (v.travou(t)) travas += 1;
      v.entrou(R.ts[k], t);
    } else v.saiu(R.ts[k], t);
  }
  return { medias, travas };
}`;
/** Uma cópia do laço por implementação: cada uma com o próprio perfil de tipos. */
const lacoPara = () => new Function(LACO)();

function bancada(Classe) {
  const executar = lacoPara();
  const rodar = () => executar(new Classe(), R);
  for (let i = 0; i < 3; i++) rodar(); // aquecimento: compilar também aloca
  globalThis.gc?.();
  const antes = process.memoryUsage().heapUsed;
  const resultado = rodar();
  const bytes = Math.max(0, process.memoryUsage().heapUsed - antes);
  return { resultado, bytes, tempo: medir(rodar) };
}

const base = bancada(Vazio);
const a = bancada(MapaAnterior);
const b = bancada(VigiaDoEncoder);

// Conferência: mesmas médias, nenhuma trava falsa.
const ma = a.resultado.medias;
const mb = b.resultado.medias;
const iguais =
  ma.length === mb.length && ma.every((m, i) => (m === null ? mb[i] === null : Math.abs(m - mb[i]) < 1e-9));
if (!iguais) {
  console.error('As médias divergem: o anel não mede o mesmo que o Map.');
  process.exit(1);
}
if (b.resultado.travas !== 0) {
  console.error(`O vigia acusou ${b.resultado.travas} trava(s) num encoder saudável.`);
  process.exit(1);
}

const liquido = (x) => ({
  ms: Math.max(0, x.tempo.medianaMs - base.tempo.medianaMs),
  bytes: Math.max(0, x.bytes - base.bytes),
});
const la = liquido(a);
const lb = liquido(b);

cabecalho(`Tempo por quadro do codificador — ${SEGUNDOS} s a ${FPS} fps (${QUADROS} quadros, 1 pulado a cada 600)`);
if (!JSON_SAIDA) {
  const ns = (ms) => fmt((ms * 1e6) / QUADROS, 0);
  console.log(`  linha de base do laço: ${fmt(base.tempo.medianaMs)} ms, ${base.bytes} bytes (descontada abaixo)\n`);
  console.log('                           ms (10 min)   ns/quadro   bytes alocados   bytes/quadro');
  console.log(`  antes (Map)              ${fmt(la.ms).padStart(10)}   ${ns(la.ms).padStart(9)}   ${String(la.bytes).padStart(14)}   ${fmt(la.bytes / QUADROS, 1).padStart(12)}`);
  console.log(`  agora (VigiaDoEncoder)   ${fmt(lb.ms).padStart(10)}   ${ns(lb.ms).padStart(9)}   ${String(lb.bytes).padStart(14)}   ${fmt(lb.bytes / QUADROS, 1).padStart(12)}`);
  console.log('\n  mesmas médias de ms/quadro em todas as leituras: sim · travas falsas: 0');
}
linha({ bench: 'vigia-do-encoder', base: { ms: base.tempo.medianaMs, bytes: base.bytes }, antes: la, agora: lb });
