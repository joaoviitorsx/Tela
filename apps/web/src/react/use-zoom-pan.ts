import { useCallback, useRef, useState } from 'react';

export const ZOOM_MINIMO = 1;
export const ZOOM_MAXIMO = 3;
export const PASSO_ZOOM = 0.25;

export type Pan = { readonly x: number; readonly y: number };

/** Múltiplos de 0,25 entre 1× e 3×. Arredondar evita 1,2500000001 na tela. */
export function ajustarZoom(atual: number, delta: number): number {
  const proximo = Math.round((atual + delta) / PASSO_ZOOM) * PASSO_ZOOM;
  return Math.max(ZOOM_MINIMO, Math.min(ZOOM_MAXIMO, proximo));
}

/**
 * O quanto a imagem pode andar sem mostrar borda preta: metade do que ela
 * cresceu, em cada eixo. Em 1× o limite é zero — o pan se desfaz sozinho ao
 * voltar para 100%.
 */
export function limitarPan(pan: Pan, zoom: number, largura: number, altura: number): Pan {
  const mx = ((zoom - 1) * largura) / 2;
  const my = ((zoom - 1) * altura) / 2;
  // `+ 0` normaliza o -0 que Math.max devolve quando o limite é zero.
  return {
    x: Math.max(-mx, Math.min(mx, pan.x)) + 0,
    y: Math.max(-my, Math.min(my, pan.y)) + 0,
  };
}

export type ZoomPan = {
  readonly zoom: number;
  readonly pan: Pan;
  readonly arrastando: boolean;
  readonly aumentar: () => void;
  readonly diminuir: () => void;
  readonly resetar: () => void;
  /** Ref do palco: é dele que vem o tamanho para limitar o arrasto. */
  readonly palcoRef: React.RefObject<HTMLDivElement | null>;
  readonly aoRodar: (evento: React.WheelEvent) => void;
  readonly aoPressionar: (evento: React.PointerEvent) => void;
  readonly aoMover: (evento: React.PointerEvent) => void;
  readonly aoSoltar: (evento: React.PointerEvent) => void;
};

/**
 * Zoom e arrasto do vídeo do espectador.
 *
 * Existe porque 1080p chega num celular ou numa janela pequena e o texto do
 * jogo vira ponto — e o mesmo bitmap tem os pixels para ampliar. Roda de mouse
 * dá zoom, arrasto move, e em 1× nada disso interfere (o arrasto só liga acima
 * de 1×, senão o duplo clique de tela cheia perderia o gesto).
 *
 * `setPointerCapture` mantém o arrasto vivo quando o cursor sai do palco, e é
 * o que faz o mesmo código servir para toque.
 */
export function useZoomPan(): ZoomPan {
  const [zoom, setZoom] = useState(ZOOM_MINIMO);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [arrastando, setArrastando] = useState(false);
  const palcoRef = useRef<HTMLDivElement | null>(null);
  const origem = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const zoomAtual = useRef(zoom);
  zoomAtual.current = zoom;
  const panAtual = useRef(pan);
  panAtual.current = pan;

  const medida = useCallback(() => {
    const palco = palcoRef.current;
    return { largura: palco?.clientWidth ?? 1200, altura: palco?.clientHeight ?? 700 };
  }, []);

  const mudarZoom = useCallback(
    (delta: number) => {
      const proximo = ajustarZoom(zoomAtual.current, delta);
      const { largura, altura } = medida();
      setZoom(proximo);
      setPan(limitarPan(panAtual.current, proximo, largura, altura));
    },
    [medida],
  );

  const aumentar = useCallback(() => mudarZoom(PASSO_ZOOM), [mudarZoom]);
  const diminuir = useCallback(() => mudarZoom(-PASSO_ZOOM), [mudarZoom]);
  const resetar = useCallback(() => {
    setZoom(ZOOM_MINIMO);
    setPan({ x: 0, y: 0 });
  }, []);

  const aoRodar = useCallback(
    (evento: React.WheelEvent) => mudarZoom(evento.deltaY < 0 ? PASSO_ZOOM : -PASSO_ZOOM),
    [mudarZoom],
  );

  const aoPressionar = useCallback((evento: React.PointerEvent) => {
    if (zoomAtual.current <= ZOOM_MINIMO) return;
    origem.current = {
      x: evento.clientX,
      y: evento.clientY,
      panX: panAtual.current.x,
      panY: panAtual.current.y,
    };
    setArrastando(true);
    evento.currentTarget.setPointerCapture?.(evento.pointerId);
  }, []);

  const aoMover = useCallback(
    (evento: React.PointerEvent) => {
      const o = origem.current;
      if (o === null) return;
      const { largura, altura } = medida();
      setPan(
        limitarPan(
          { x: o.panX + evento.clientX - o.x, y: o.panY + evento.clientY - o.y },
          zoomAtual.current,
          largura,
          altura,
        ),
      );
    },
    [medida],
  );

  const aoSoltar = useCallback((evento: React.PointerEvent) => {
    if (origem.current === null) return;
    origem.current = null;
    setArrastando(false);
    evento.currentTarget.releasePointerCapture?.(evento.pointerId);
  }, []);

  return { zoom, pan, arrastando, aumentar, diminuir, resetar, palcoRef, aoRodar, aoPressionar, aoMover, aoSoltar };
}
