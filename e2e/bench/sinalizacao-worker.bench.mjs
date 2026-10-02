/**
 * O padrão de `apps/signaling/src/worker.ts`: toda consulta à sala percorre
 * `ctx.getWebSockets()` e DESSERIALIZA o attachment de cada socket
 * (`peers()` → `attachmentOf` → `deserializeAttachment`). `relay()` chama
 * `host()` ou `viewers()` duas vezes por sinal, e cada uma é uma varredura
 * completa: O(N) por mensagem de sinalização, O(N²) numa entrada em massa.
 *
 * Isto NÃO roda o Durable Object. Reproduz o padrão em Node com
 * `v8.serialize`/`v8.deserialize` fazendo o papel de
 * `serializeAttachment`/`deserializeAttachment` (a plataforma usa a
 * serialização estruturada do V8; o custo real pode diferir e fica marcado
 * como "medir no Worker"). O que se compara:
 *
 *   varredura   o código de hoje: N desserializações por consulta, 2–3
 *               consultas por sinal;
 *   índice      um `Map<peerId, {socket, at}>` reconstruído UMA vez por
 *               mensagem (ou por acordar da hibernação) e consultado em O(1).
 *
 *   node e2e/bench/sinalizacao-worker.bench.mjs
 */
import { serialize, deserialize } from 'node:v8';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import { cabecalho, medir, fmt, linha, JSON_SAIDA, RAIZ, sobTsx } from './comum.mjs';

// A parte "Worker real" importa o TypeScript de apps/signaling (ChannelRoom).
sobTsx(import.meta.url);

function socketFalso(at) {
  let guardado = serialize(at);
  return {
    serializeAttachment(v) { guardado = serialize(v); },
    deserializeAttachment() { return deserialize(guardado); },
    send() { /* nada */ },
  };
}

function sala(n) {
  const sockets = [socketFalso({ peerId: 'host', role: 'host', ownerHash: 'abc'.repeat(21), janelaInicio: 0, janelaContagem: 1, ready: true })];
  for (let i = 0; i < n; i += 1) {
    sockets.push(socketFalso({ peerId: `v${i.toString(36).padStart(8, 'x')}`, role: 'viewer', name: `amigo ${i}`, fingerprint: 'f'.repeat(32), janelaInicio: 0, janelaContagem: 3, ready: true }));
  }
  return sockets;
}

/* ───── hoje: varredura por consulta ───── */
function peers(sockets) {
  const out = [];
  for (const s of sockets) {
    const at = s.deserializeAttachment();
    if (at !== null && typeof at.peerId === 'string') out.push({ socket: s, at });
  }
  return out;
}
const host = (sockets) => peers(sockets).find((p) => p.at.role === 'host') ?? null;
const viewers = (sockets) => peers(sockets).filter((p) => p.at.role === 'viewer' && p.at.removido !== true && p.at.pendente !== true);

/** `relay()` de um sinal do HOST para o espectador `to`, como em worker.ts. */
function relayVarredura(sockets, socketDoHost, to) {
  if (host(sockets)?.socket !== socketDoHost) return null; // 1ª varredura
  const target = viewers(sockets).find((v) => v.at.peerId === to && v.at.ready !== false) ?? null; // 2ª
  return target;
}

/* ───── alternativa: índice por mensagem ───── */
function indice(sockets) {
  const porId = new Map();
  let h = null;
  for (const s of sockets) {
    const at = s.deserializeAttachment();
    if (at === null || typeof at.peerId !== 'string') continue;
    const p = { socket: s, at };
    porId.set(at.peerId, p);
    if (at.role === 'host') h = p;
  }
  return { porId, host: h };
}
function relayIndice(idx, socketDoHost, to) {
  if (idx.host?.socket !== socketDoHost) return null;
  const v = idx.porId.get(to);
  return v !== undefined && v.at.role === 'viewer' && v.at.ready !== false && v.at.removido !== true ? v : null;
}

cabecalho('Sinalização (Worker) — custo de relay() por varredura de attachments vs índice');

/** Sinais por espectador numa entrada em rede real: oferta + resposta + ~15 candidatos de cada lado. */
const SINAIS_POR_ENTRADA = 30;

if (!JSON_SAIDA) {
  console.log(' N   desserializações/sinal   relay varredura (µs)   relay índice* (µs)   entrada de N (varredura, ms)   entrada de N (índice, ms)');
}
for (const n of [5, 20, 50]) {
  const sockets = sala(n);
  const socketDoHost = sockets[0];
  const alvos = sockets.slice(1).map((s) => s.deserializeAttachment().peerId);
  const mv = medir(() => {
    let achados = 0;
    for (const to of alvos) if (relayVarredura(sockets, socketDoHost, to) !== null) achados += 1;
    return achados;
  });
  const mi = medir(() => {
    let achados = 0;
    for (const to of alvos) {
      const idx = indice(sockets); // reconstruído por mensagem: ainda N desserializações, mas UMA vez
      if (relayIndice(idx, socketDoHost, to) !== null) achados += 1;
    }
    return achados;
  });
  const mc = medir(() => {
    // Índice mantido em memória entre mensagens (invalidado quando um attachment muda).
    const idx = indice(sockets);
    let achados = 0;
    for (const to of alvos) if (relayIndice(idx, socketDoHost, to) !== null) achados += 1;
    return achados;
  });
  if (mv.sentinela !== n || mi.sentinela !== n || mc.sentinela !== n) {
    console.error('relay divergiu', mv.sentinela, mi.sentinela, mc.sentinela);
    process.exit(1);
  }
  const usV = (mv.medianaMs * 1000) / n;
  const usI = (mi.medianaMs * 1000) / n;
  const usC = (mc.medianaMs * 1000) / n;
  const entradaV = (usV * SINAIS_POR_ENTRADA * n) / 1000;
  const entradaC = (usC * SINAIS_POR_ENTRADA * n) / 1000;
  if (!JSON_SAIDA) {
    console.log(
      `${String(n).padStart(2)}   ${String(2 * (n + 1)).padStart(21)}   ${fmt(usV, 1).padStart(20)}   ${fmt(usI, 1).padStart(7)} / ${fmt(usC, 2).padStart(6)}   ${fmt(entradaV, 1).padStart(27)}   ${fmt(entradaC, 2).padStart(24)}`,
    );
  }
  linha({ bench: 'sinalizacao-worker', n, usPorRelayVarredura: usV, usPorRelayIndicePorMensagem: usI, usPorRelayIndiceCache: usC, entradaMsVarredura: entradaV, entradaMsIndice: entradaC });
}
if (!JSON_SAIDA) {
  console.log('\n* índice: "por mensagem" reconstrói o Map a cada sinal (N desserializações, 1 vez); "cache" mantém o Map entre mensagens.');
  console.log(`  "entrada de N" = N espectadores entrando juntos × ${SINAIS_POR_ENTRADA} sinais cada, só o custo de relay no DO.`);
}

/* ───────────── o ChannelRoom REAL (ADR 0031) ─────────────
 *
 * Acima, o proxy. Aqui, a classe de verdade de `worker.ts` com sockets cujo
 * attachment passa por `v8.serialize/deserialize` (custo próximo ao da
 * serialização estruturada da plataforma; no Worker real pode ser maior).
 * `WORKER_TS=<caminho>` aponta para outra versão do arquivo (para medir o
 * "antes" a partir de `git show`). Mede só o relay: sala já cheia, host e
 * espectadores trocam sinais.
 */
const { ChannelRoom, makeChannelDeps } = await import(process.env['WORKER_TS'] ?? join(RAIZ, 'apps/signaling/src/worker.ts'));

function socketReal() {
  let guardado = null;
  let leituras = 0;
  return {
    sent: [],
    closed: false,
    get leituras() { return leituras; },
    send(d) { this.sent.push(d); },
    close() { if (!this.closed) { this.closed = true; this.aoFechar?.(); } },
    serializeAttachment(v) { guardado = serialize(v); },
    deserializeAttachment() { leituras += 1; return guardado === null ? null : deserialize(guardado); },
  };
}

async function salaReal(n) {
  const deps = makeChannelDeps({ CHANNELS: null, MAX_PEERS: String(n) }, webcrypto);
  const sockets = [];
  const ctx = {
    acceptWebSocket(s) { sockets.push(s); },
    getWebSockets() { return sockets.filter((s) => !s.closed); },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const room = new ChannelRoom(ctx, deps);
  const abrir = () => { const s = socketReal(); s.aoFechar = () => room.handleClose(s); room.accept(s); return s; };
  const slug = 'bench-sala';
  const host = abrir();
  await room.handleMessage(host, slug, JSON.stringify({ type: 'host', slug, ownerToken: 'o'.repeat(43), protocol: 5, capacidade: n }));
  const viewers = [];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i += 1) {
    const v = abrir();
    await room.handleMessage(v, slug, JSON.stringify({ type: 'watch', slug, protocol: 5, participantId: `participante-${i}`.padEnd(20, 'p'), name: `amigo ${i}`, viewerKey: `k${i}`.padEnd(22, 'k') }));
    viewers.push(v);
  }
  const entradaMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const ids = viewers.map((v) => JSON.parse(v.sent.find((m) => JSON.parse(m).type === 'watching')).peerId);
  return { room, slug, host, viewers, ids, entradaMs, sockets };
}

if (!JSON_SAIDA) console.log('\nChannelRoom real: relay por sinal (sala já cheia) e entrada em massa (N watch seguidos)');
for (const n of [5, 20, 50]) {
  const s = await salaReal(n);
  let lidas = 0;
  const m = medir(() => {
    const antes = s.sockets.reduce((a, x) => a + x.leituras, 0);
    for (let i = 0; i < n; i += 1) {
      void s.room.handleMessage(s.host, s.slug, JSON.stringify({ type: 'signal', to: s.ids[i], payload: 'x' }));
      void s.room.handleMessage(s.viewers[i], s.slug, JSON.stringify({ type: 'signal', payload: 'y' }));
    }
    lidas = s.sockets.reduce((a, x) => a + x.leituras, 0) - antes;
    for (const x of s.sockets) x.sent.length = 0;
    return lidas;
  });
  const usPorSinal = (m.medianaMs * 1000) / (2 * n);
  const deserPorSinal = lidas / (2 * n);
  if (!JSON_SAIDA) {
    console.log(`N=${String(n).padStart(2)}   ${fmt(usPorSinal, 1).padStart(7)} µs/sinal   ${fmt(deserPorSinal, 1).padStart(6)} desserializações/sinal   entrada em massa: ${fmt(s.entradaMs, 1)} ms`);
  }
  linha({ bench: 'sinalizacao-worker-real', n, usPorSinal, deserPorSinal, entradaMs: s.entradaMs });
}
