// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ajustarZoom, limitarPan, useZoomPan } from './use-zoom-pan.js';

afterEach(cleanup);

describe('ajustarZoom', () => {
  it('anda de 0,25 em 0,25 entre 1× e 3×', () => {
    expect(ajustarZoom(1, 0.25)).toBe(1.25);
    expect(ajustarZoom(2.75, 0.25)).toBe(3);
    expect(ajustarZoom(3, 0.25)).toBe(3);
    expect(ajustarZoom(1, -0.25)).toBe(1);
  });

  it('não acumula erro de ponto flutuante', () => {
    let z = 1;
    for (let i = 0; i < 6; i += 1) z = ajustarZoom(z, 0.25);
    expect(z).toBe(2.5);
  });
});

describe('limitarPan', () => {
  it('em 1× o limite é zero: a imagem não anda', () => {
    expect(limitarPan({ x: 90, y: -40 }, 1, 1200, 700)).toEqual({ x: 0, y: 0 });
  });

  it('em 2× anda metade do que cresceu, em cada eixo', () => {
    expect(limitarPan({ x: 9_999, y: -9_999 }, 2, 1200, 700)).toEqual({ x: 600, y: -350 });
    expect(limitarPan({ x: 100, y: 50 }, 2, 1200, 700)).toEqual({ x: 100, y: 50 });
  });
});

describe('useZoomPan', () => {
  it('a roda amplia e reduz', () => {
    const { result } = renderHook(() => useZoomPan());

    act(() => result.current.aoRodar({ deltaY: -100 } as React.WheelEvent));
    act(() => result.current.aoRodar({ deltaY: -100 } as React.WheelEvent));
    expect(result.current.zoom).toBe(1.5);

    act(() => result.current.aoRodar({ deltaY: 100 } as React.WheelEvent));
    expect(result.current.zoom).toBe(1.25);
  });

  it('voltar a 1× desfaz o pan', () => {
    const { result } = renderHook(() => useZoomPan());
    const alvo = { setPointerCapture: () => undefined, releasePointerCapture: () => undefined };
    const evento = (x: number, y: number) =>
      ({ clientX: x, clientY: y, pointerId: 1, currentTarget: alvo }) as unknown as React.PointerEvent;

    act(() => result.current.aumentar());
    act(() => result.current.aumentar());
    act(() => result.current.aoPressionar(evento(0, 0)));
    act(() => result.current.aoMover(evento(80, 30)));
    expect(result.current.arrastando).toBe(true);
    expect(result.current.pan.x).toBeGreaterThan(0);

    act(() => result.current.aoSoltar(evento(80, 30)));
    act(() => result.current.resetar());

    expect(result.current).toMatchObject({ zoom: 1, pan: { x: 0, y: 0 }, arrastando: false });
  });

  it('em 1× o arrasto não liga (o duplo clique de tela cheia mantém o gesto)', () => {
    const { result } = renderHook(() => useZoomPan());
    const evento = { clientX: 0, clientY: 0, pointerId: 1, currentTarget: {} } as unknown as React.PointerEvent;

    act(() => result.current.aoPressionar(evento));

    expect(result.current.arrastando).toBe(false);
  });
});
