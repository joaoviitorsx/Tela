import { useEffect, useRef } from 'react';
import type { EstadoVitrine, Vitrine } from '../core/ports/crt-vitrine.js';
import { abrirVitrineCrt, suporteDeAbertura } from '../container.js';

/**
 * O aparelho ao lado do campo, montado e alimentado.
 *
 * Duas coisas separadas de propósito:
 *
 * - **Montar** acontece uma vez, no primeiro efeito, e é caro (contexto WebGL +
 *   modelo). Depende de nada; a limpeza devolve a GPU quando a home sai.
 * - **Alimentar** acontece a cada tecla digitada e é barato — repinta uma
 *   textura de 512×348 e troca a cor de uma lâmpada. Por isso `mostra` mora num
 *   efeito próprio e a cena nunca é remontada por causa de estado.
 *
 * O modelo é o mesmo `.glb` da abertura, já no cache do navegador quando esta
 * cena pede — a abertura acabou de baixá-lo.
 */
export type Vitrine3D = {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** `false` = nem o canvas nasce. Sem WebGL não há o que mostrar. */
  readonly disponivel: boolean;
};

export function useVitrine(estado: EstadoVitrine, aoClicar: () => void): Vitrine3D {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const vitrineRef = useRef<Vitrine | null>(null);
  const estadoRef = useRef(estado);
  const aoClicarRef = useRef(aoClicar);

  estadoRef.current = estado;
  aoClicarRef.current = aoClicar;

  const disponivel = suporteDeAbertura();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || !disponivel) return;

    let vivo = true;
    const abortador = new AbortController();

    const tamanho = () => {
      const caixa = canvas.getBoundingClientRect();
      return {
        largura: Math.max(1, Math.round(caixa.width)),
        altura: Math.max(1, Math.round(caixa.height)),
      };
    };

    void (async () => {
      const { largura, altura } = tamanho();
      let aberta: Vitrine;
      try {
        aberta = await abrirVitrineCrt({
          canvas,
          modeloUrl: '/tela-crt.glb',
          largura,
          altura,
          dpr: Math.min(window.devicePixelRatio, 2),
          movimentoReduzido: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          estadoInicial: estadoRef.current,
          // Por referência e não por valor: o `onClick` da home muda de
          // identidade a cada render, e remontar a cena por causa disso
          // recarregaria o modelo a cada tecla digitada.
          aoClicar: () => aoClicarRef.current(),
          sinal: abortador.signal,
        });
      } catch {
        // Sem cena, a tela inicial continua inteira: o aparelho é o único que
        // some. Nada aqui é caminho de nenhuma tarefa.
        return;
      }

      if (!vivo) {
        aberta.dispose();
        return;
      }
      vitrineRef.current = aberta;
      // O estado pode ter mudado enquanto o modelo chegava.
      aberta.mostra(estadoRef.current);
    })();

    const observador = new ResizeObserver(() => {
      const { largura, altura } = tamanho();
      vitrineRef.current?.redimensiona(largura, altura, Math.min(window.devicePixelRatio, 2));
    });
    observador.observe(canvas);

    return () => {
      vivo = false;
      abortador.abort();
      observador.disconnect();
      vitrineRef.current?.dispose();
      vitrineRef.current = null;
    };
  }, [disponivel]);

  useEffect(() => {
    vitrineRef.current?.mostra(estado);
  }, [estado]);

  return { canvasRef, disponivel };
}
