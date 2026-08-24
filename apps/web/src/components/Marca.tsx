type Props = {
  /** `grande` na tela inicial. `padrao` nas outras páginas e no console. */
  readonly tamanho?: 'padrao' | 'grande';
};

/**
 * A marca: quatro letras dentro de um vidro.
 *
 * O nome estava em 15px de Geist semibold — o mesmo desenho do nome de
 * qualquer aplicativo, e a única coisa que identificava o produto na tela. O
 * que dá entonação aqui não é o corpo da letra: é o VIDRO em volta dela.
 *
 * A plaqueta é a mesma pilha de camadas da abertura em escala de nameplate —
 * scanline de 3px, roll bar lenta, vinheta nos cantos, fundo `void` sobre a
 * faixa `surface`. Quem viu o tubo se abrir reconhece o tubo aqui, e a mesma
 * ideia reaparece em três tamanhos: plaqueta, abertura e tela de espera.
 *
 * Caixa alta em condensada, não caixa baixa em Geist. "tela" em minúsculas era
 * literal demais para um nome de quatro letras: sobrava a palavra e faltava a
 * marca. Em caixa alta e estreita ela vira o que está serigrafado na chapa —
 * que é como aparelho de vídeo se identifica.
 *
 * A borda é `line`, não `edge`: a plaqueta não é um controle, e `edge` tem um
 * papel escrito na ADR 0008. O que desenha o retângulo é o degrau de `void`
 * sobre `surface` mais as scanlines; a borda só impede que ele pareça um
 * recorte solto.
 */
export function Marca({ tamanho = 'padrao' }: Props) {
  const grande = tamanho === 'grande';

  return (
    <span
      data-vidro="contorno"
      className={[
        'vidro inline-flex select-none items-center rounded-sm border border-line',
        grande ? 'px-3 py-1.5' : 'px-2.5 py-1',
      ].join(' ')}
    >
      <span
        className="font-etiqueta font-bold uppercase leading-none text-text"
        style={{
          fontSize: grande ? 26 : 19,
          letterSpacing: '0.1em',
          // A entreletra abre o texto para a direita e o deixa visualmente
          // descentrado dentro da plaqueta. O recuo devolve o espaço da última.
          paddingRight: '0.1em',
        }}
      >
        tela
      </span>
    </span>
  );
}
