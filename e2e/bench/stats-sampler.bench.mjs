/**
 * `StatsSampler.readMany` com N relatórios por tique (1 Hz no transmissor).
 *
 * Um relatório do `getStats()` do Chromium para uma `RTCPeerConnection` com
 * vídeo e áudio tem da ordem de 60 a 120 objetos (codec, transport, pares de
 * candidatos — vários —, candidatos locais e remotos, certificados,
 * media-source, outbound-rtp, remote-inbound-rtp...). Aqui cada relatório
 * sintético tem E=90 objetos, dos quais 1 `outbound-rtp` de vídeo, 1 de áudio
 * e 1 `candidate-pair` nominado — o que o sampler de fato lê.
 *
 * O que se mede é só o lado JavaScript: `readMany` (vídeo) + `AudioStatsSampler`
 * (ele chama por dentro). O custo do `getStats()` em si — a viagem até a thread
 * de rede do Chromium e a serialização dos objetos — NÃO está aqui: fica para
 * medir em navegador (procedimento em `docs/engenharia/complexidade.md`, §B).
 *
 *   node e2e/bench/stats-sampler.bench.mjs
 */
import { sobTsx, W, cabecalho, medir, fmt, linha, rng, JSON_SAIDA } from './comum.mjs';

sobTsx(import.meta.url);

const { StatsSampler } = await import(W('core/media/stats-sampler.ts'));
const { statsReport } = await import(W('core/mesh/testing.ts'));

const E = 90;

function relatorio(peer, tique, r) {
  const entradas = [];
  const ts = 1_700_000_000_000 + tique * 1000;
  entradas.push({
    id: `OV${peer}`, type: 'outbound-rtp', kind: 'video', ssrc: 1000 + peer, timestamp: ts,
    bytesSent: tique * 1_500_000 + Math.floor(r() * 10_000), framesEncoded: tique * 60, framesPerSecond: 60,
    frameWidth: 1920, frameHeight: 1080, qualityLimitationReason: 'none', qpSum: tique * 60 * 28,
    totalEncodeTime: tique * 60 * 0.004, encoderImplementation: 'ExternalEncoder',
  });
  entradas.push({
    id: `OA${peer}`, type: 'outbound-rtp', kind: 'audio', ssrc: 2000 + peer, timestamp: ts,
    bytesSent: tique * 16_000, packetsSent: tique * 50,
  });
  entradas.push({
    id: `CP${peer}`, type: 'candidate-pair', state: 'succeeded', nominated: true, timestamp: ts,
    currentRoundTripTime: 0.02 + r() * 0.03, availableOutgoingBitrate: 10_000_000 + r() * 2_000_000,
    localCandidateId: `L${peer}`, remoteCandidateId: `R${peer}`,
  });
  const tipos = ['candidate-pair', 'local-candidate', 'remote-candidate', 'codec', 'transport', 'certificate', 'media-source', 'remote-inbound-rtp', 'data-channel'];
  for (let i = entradas.length; i < E; i += 1) {
    entradas.push({ id: `X${peer}-${i}`, type: tipos[i % tipos.length], state: 'waiting', timestamp: ts, a: i, b: r(), c: 'texto' });
  }
  return statsReport(entradas);
}

cabecalho(`StatsSampler.readMany — N relatórios de ${E} objetos, 10 tiques (10 s)`);

if (!JSON_SAIDA) console.log(' N   10 tiques (ms)   ms por tique   µs por relatório');
for (const n of [1, 5, 20, 50]) {
  const r = rng(11);
  const tiques = Array.from({ length: 10 }, (_, t) =>
    Array.from({ length: n }, (_, p) => ({ peerId: `p${p}`, report: relatorio(p, t + 1, r) })),
  );
  const m = medir(() => {
    const s = new StatsSampler('outbound');
    let ultimo = null;
    for (const entradas of tiques) ultimo = s.readMany(entradas);
    return ultimo;
  });
  if (m.sentinela === null || typeof m.sentinela.bitrateBps !== 'number') {
    console.error('o sampler não devolveu stats', m.sentinela);
    process.exit(1);
  }
  const porTique = m.medianaMs / 10;
  if (!JSON_SAIDA) {
    console.log(`${String(n).padStart(2)}   ${fmt(m.medianaMs).padStart(14)}   ${fmt(porTique, 3).padStart(12)}   ${fmt((porTique * 1000) / n, 1).padStart(16)}`);
  }
  linha({ bench: 'stats-sampler', n, objetosPorRelatorio: E, ms10Tiques: m.medianaMs, msPorTique: porTique, bitrateBps: m.sentinela.bitrateBps });
}
