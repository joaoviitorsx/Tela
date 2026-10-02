import { type FonteDeVisibilidade, visibilidadeDoDocumento } from '../react/use-aba-visivel.js';
import type { ModoDaJanelaStore } from './modo-da-janela.js';
import type { PonteDesktop } from './ponte.js';

/**
 * A visibilidade no app: a janela, segundo o processo principal, E o
 * documento, segundo o Chromium.
 *
 * Com `backgroundThrottling: false` o Chromium nunca diz "oculta" sozinho
 * (PLANO-desktop §3.2), então o main avisa pela ponte. O documento continua na
 * conta porque, se um dia ele disser "oculta", está certo também. A janela
 * nasce visível: o app abre com ela na frente, e o main manda o estado real na
 * primeira mudança.
 *
 * No modo compacto a janela está visível, mas a interface grande não: o que
 * ela mostra é uma faixa, e animação, prévia e TV 3D não têm por que correr.
 * Conta como oculta — é o mesmo "modo escondido" (§3.2), sem inventar um
 * segundo caminho.
 */
export function fonteDeVisibilidadeDesktop(
  ponte: Pick<PonteDesktop, 'aoMudarVisibilidade'>,
  documento: FonteDeVisibilidade = visibilidadeDoDocumento,
  modo?: Pick<ModoDaJanelaStore, 'atual' | 'assinar'>,
): FonteDeVisibilidade {
  let janelaVisivel = true;
  return {
    visivel: () => janelaVisivel && documento.visivel() && modo?.atual() !== 'compacto',
    assinar: (ouvinte) => {
      const cancelarModo = modo?.assinar(ouvinte);
      const cancelarJanela = ponte.aoMudarVisibilidade((visivel) => {
        janelaVisivel = visivel;
        ouvinte();
      });
      const cancelarDocumento = documento.assinar(ouvinte);
      return () => {
        cancelarModo?.();
        cancelarJanela();
        cancelarDocumento();
      };
    },
  };
}
