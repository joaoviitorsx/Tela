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
import { cabecalho, medir, fmt, linha, JSON_SAIDA } from './comum.mjs';

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
