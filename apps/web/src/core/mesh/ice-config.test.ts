import { expect, it } from 'vitest';
import { isRelayed, selectedIcePath } from './ice-config.js';

function report(...entries: Array<Record<string, unknown>>): RTCStatsReport {
  const values = new Map(entries.map((entry) => [entry['id'] as string, entry]));
  return values as unknown as RTCStatsReport;
}

it('usa o par apontado pelo transport, ignorando relay histórico', () => {
  const stats = report(
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'direct', iceState: 'connected', dtlsState: 'connected' },
    { id: 'old', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'relay', remoteCandidateId: 'remote' },
    { id: 'direct', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'host', remoteCandidateId: 'remote' },
    { id: 'relay', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tls', protocol: 'udp' },
    { id: 'host', type: 'local-candidate', candidateType: 'host' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'host' },
  );
  expect(isRelayed(stats)).toBe(false);
  expect(selectedIcePath(stats)).toEqual({
    source: 'transport', localType: 'host', remoteType: 'host', relayProtocol: null,
    iceState: 'connected', dtlsState: 'connected',
  });
});

it('registra relayProtocol do candidato local selecionado, não candidate.protocol', () => {
  const stats = report(
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote' },
    { id: 'local', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'relay' },
  );
  expect(isRelayed(stats)).toBe(true);
  expect(selectedIcePath(stats)?.relayProtocol).toBe('tls');
});

it('fallback só escolhe par único; ambiguidade não vira relay', () => {
  const stats = report(
    { id: 'a', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'relay' },
    { id: 'b', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'host' },
    { id: 'relay', type: 'local-candidate', candidateType: 'relay' },
    { id: 'host', type: 'local-candidate', candidateType: 'host' },
  );
  expect(selectedIcePath(stats)).toBeNull();
  expect(isRelayed(stats)).toBe(false);
  expect(selectedIcePath(report(
    { id: 'a', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'relay' },
    { id: 'relay', type: 'local-candidate', candidateType: 'relay' },
  ))?.source).toBe('unique-nominated');
});
