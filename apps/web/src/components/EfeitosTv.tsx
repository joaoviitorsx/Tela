/**
 * O vidro do aparelho por cima da chrome da página: scanlines estáticas e
 * vinheta. `aria-hidden` e `pointer-events: none` — é só pintura.
 *
 * Um elemento `fixed` com fundo estático é uma camada de composição e nada
 * mais: nenhum quadro é repintado por ele. Fica de fora do espectador, onde o
 * vídeo do jogo é o conteúdo (`acima-do-crt` cobre os casos de imagem dentro
 * das páginas que o usam).
 */
export function VidroCrt() {
  return <div aria-hidden="true" className="crt-vidro" />;
}

/**
 * O chiado da troca de canal: 260ms, uma vez, entre um passo e outro. Só é
 * montado enquanto dura, então fora da troca não existe nem no DOM.
 */
export function EstaticaTroca({ ativa }: { readonly ativa: boolean }) {
  if (!ativa) return null;
  return (
    <div
      aria-hidden="true"
      className="chiado chiado-troca pointer-events-none fixed inset-0 z-[60] opacity-90"
    />
  );
}

/**
 * O número do canal sintonizado, piscando três vezes no canto. Não é a única
 * fonte da informação: o título do passo já diz onde a pessoa está.
 */
export function CanalFlash({
  visivel,
  numero,
  nome,
}: {
  readonly visivel: boolean;
  readonly numero: string;
  readonly nome: string;
}) {
  if (!visivel) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed right-4 top-[72px] z-[55] flex flex-col items-end sm:right-6"
    >
      <span className="numeral canal-flash text-[clamp(56px,9vw,96px)] leading-[0.8] text-ok [text-shadow:0_0_14px_rgb(143_214_148_/_0.6),3px_3px_0_#000]">
        {numero}
      </span>
      <span className="font-[family-name:var(--font-pixel)] text-[13px] text-ok [text-shadow:1px_1px_0_#000]">
        {nome}
      </span>
    </div>
  );
}
