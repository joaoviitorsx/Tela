type Props = {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly montado: boolean;
};

/**
 * O aparelho ao lado do campo. Só o canvas — o comportamento mora em
 * `react/use-vitrine.ts` (ADR 0014).
 *
 * # O que é desenho aqui
 *
 * Um clarão âmbar estático atrás do tubo e uma prateleira de 2px embaixo: é o
 * que faz o modelo 3D, que tem fundo transparente, ler como um objeto de pé
 * sobre a chapa e não como um adesivo. Os dois são CSS estático — nenhum custo
 * além do que a cena já paga.
 *
 * # Por que não aparece no celular
 *
 * `hidden lg:block`. Em 390px a faixa do canal já ocupa a tela com campo, aviso
 * e botão, e um aparelho de 300px empurraria o TRANSMITIR para baixo da dobra.
 * Trocar o botão principal por um enfeite é o oposto do que o produto pede. E é
 * GPU contínua na bateria de quem está com o celular na mão.
 *
 * # Por que `aria-hidden`
 *
 * Tudo que o tubo mostra — o endereço sendo digitado e se ele serve — já está
 * no campo ao lado, com `role="status"` e frase inteira. Anunciar de novo faria
 * o leitor de tela repetir cada tecla duas vezes. O clique aqui só põe o cursor
 * no campo, que é o próximo ponto de tabulação de qualquer jeito.
 *
 * Sem `tabIndex`: um `<canvas>` não entra na ordem de tabulação, e
 * `tabIndex={-1}` só serviria para ele ROUBAR o foco no clique.
 */
export function Vitrine({ canvasRef, montado }: Props) {
  if (!montado) return null;

  return (
    <div className="hidden shrink-0 lg:block">
      <div className="relative bg-[radial-gradient(ellipse_60%_55%_at_50%_52%,rgb(242_169_59_/_0.11),transparent_70%)]">
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="block h-[340px] w-[340px] xl:h-[400px] xl:w-[400px]"
        />
        <div
          aria-hidden="true"
          className="absolute inset-x-8 bottom-[15%] h-0.5 bg-line shadow-[0_6px_18px_rgb(0_0_0_/_0.8)]"
        />
      </div>
    </div>
  );
}
