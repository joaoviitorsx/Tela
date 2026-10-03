/**
 * Sincronia da multivisão (ADR 0032): dois amigos na MESMA partida, cada um
 * transmitindo — a mesma jogada tem de aparecer nas duas telas ao mesmo
 * tempo. Cada canal chega com a sua latência; alinhar é atrasar o mais
 * rápido até o mais lento. Nunca o contrário: não dá para adiantar imagem.
 *
 * A entrada é a latência NATURAL de cada canal (a que a rede entrega, sem o
 * atraso que a própria sincronia pôs — a sessão já a mede assim), então não
 * há realimentação: o atraso não muda o que se mede.
 *
 * Passo limitado por tique e zona morta: o atraso anda devagar e para quando
 * chega perto, para a imagem não "respirar" a cada amostra.
 */
export const ZONA_MORTA_MS = 25;
export const PASSO_MAXIMO_MS = 60;

const limitar = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function proximosAtrasos(
  naturais: readonly [number | null, number | null],
  atuais: readonly [number, number],
  maximoMs: number,
): readonly [number, number] {
  const [a, b] = naturais;
  // Sem medida de um dos dois, segura onde está: alinhar no escuro é chute.
  if (a === null || b === null) return atuais;
  const alvo = Math.max(a, b);
  const passo = (atual: number, natural: number): number => {
    const desejado = limitar(alvo - natural, 0, maximoMs);
    const falta = desejado - atual;
    if (Math.abs(falta) < ZONA_MORTA_MS) return atual;
    return Math.round(atual + limitar(falta, -PASSO_MAXIMO_MS, PASSO_MAXIMO_MS));
  };
  return [passo(atuais[0], a), passo(atuais[1], b)];
}
