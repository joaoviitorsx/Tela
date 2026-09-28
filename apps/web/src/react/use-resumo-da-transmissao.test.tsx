// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BroadcastState } from '../core/media/broadcast-session.js';
import { useResumoDaTransmissao } from './use-resumo-da-transmissao.js';

const vivo = (conectados: number, presetId = 'p1080p60') =>
  ({
    status: 'live',
    presetId,
    peers: Array.from({ length: conectados }, (_, i) => ({
      id: `v_${i}`, connectionState: 'connected', usingRelay: false,
    })),
  }) as unknown as BroadcastState;

describe('useResumoDaTransmissao', () => {
  it('anota tempo, pico e o último degrau, e entrega ao encerrar', () => {
    let t = 1_000_000;
    const agora = () => t;
    const rotulo = (id: string) => id.replace('p', '');
    const { result, rerender } = renderHook(({ s }) => useResumoDaTransmissao(s, rotulo, agora), {
      initialProps: { s: vivo(0) },
    });
    rerender({ s: vivo(3) });
    rerender({ s: vivo(1, 'p720p60') });
    t += 125_000;
    rerender({ s: { status: 'ended', reason: 'USER_STOPPED' } as BroadcastState });
    expect(result.current).toEqual({ tempoNoAr: '00:02:05', pico: 3, qualidade: '720p60' });
  });

  it('sem ter ido ao ar não há resumo', () => {
    const { result, rerender } = renderHook(({ s }) => useResumoDaTransmissao(s, String), {
      initialProps: { s: { status: 'requesting-capture' } as BroadcastState },
    });
    rerender({ s: { status: 'ended', reason: 'CAPTURE_DENIED' } as BroadcastState });
    expect(result.current).toBeNull();
  });
});
