type Props = {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Enquanto true o canvas existe. `false` = removido do DOM, não escondido. */
  readonly montado: boolean;
};

/**
 * O canvas da abertura, e nada mais.
 *
 * Todo o comportamento mora em `react/use-abertura.ts`. Aqui só a pilha de
 * camadas do §7, que tem três regras e nenhuma é decorativa:
 *
 * - `pointer-events: none` — o canvas NUNCA captura ponteiro. O que impede o
 *   primeiro toque de acionar o botão de baixo é o escudo de 250 ms, não este
 *   elemento;
 * - `background: var(--color-void)` — o canvas precisa ser opaco antes de o
 *   WebGL pintar o primeiro pixel, senão o DOM aparece por trás durante a
 *   sondagem. `void` é a cor do `body`: para quem olha, é a página carregando;
 * - `aria-hidden` — a abertura não tem conteúdo. Quem usa leitor de tela já
 *   está ouvindo a home, que está montada e interativa desde `t = 0`.
 *
 * Quando `montado` vira `false` o elemento sai do DOM. Nunca `display: none`:
 * com o canvas montado o contexto WebGL segue vivo e a GPU segue alocada.
 */
export function Abertura({ canvasRef, montado }: Props) {
  if (!montado) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 h-full w-full bg-void"
    />
  );
}
