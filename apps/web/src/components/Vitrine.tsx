type Props = {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly montado: boolean;
};

/**
 * O aparelho ao lado do campo. Só o canvas — o comportamento mora em
 * `react/use-vitrine.ts`.
 *
 * # Por que não aparece no celular
 *
 * `hidden lg:block`. Não é por ser difícil: em 390px de largura a faixa do
 * canal já ocupa a tela inteira com campo, aviso e botão, e um aparelho de
 * 300px empurraria o TRANSMITIR para baixo da dobra. Trocar o botão principal
 * por um enfeite é o oposto do que a ADR 0008 pede. Somando: é GPU contínua na
 * bateria de quem está com o celular na mão.
 *
 * # Por que `aria-hidden`
 *
 * Tudo que o tubo mostra — o endereço sendo digitado e se ele serve — já está
 * no campo ao lado, com `role="status"` e frase inteira. Anunciar de novo faria
 * o leitor de tela repetir cada tecla duas vezes. O clique aqui só põe o cursor
 * no campo, que é o próximo ponto de tabulação de qualquer jeito: quem navega
 * por teclado não perde nada por não alcançar o canvas.
 *
 * Sem `tabIndex`: um `<canvas>` não entra na ordem de tabulação por padrão, e
 * `tabIndex={-1}` só serviria para ele ROUBAR o foco no clique — que é
 * exatamente o oposto do que o clique existe para fazer.
 */
export function Vitrine({ canvasRef, montado }: Props) {
  if (!montado) return null;

  return (
    <div className="hidden shrink-0 lg:block">
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="block h-[340px] w-[340px] xl:h-[400px] xl:w-[400px]"
      />
    </div>
  );
}
