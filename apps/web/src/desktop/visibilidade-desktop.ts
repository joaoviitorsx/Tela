import { type FonteDeVisibilidade, visibilidadeDoDocumento } from '../react/use-aba-visivel.js';
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
 */
export function fonteDeVisibilidadeDesktop(
  ponte: Pick<PonteDesktop, 'aoMudarVisibilidade'>,
  documento: FonteDeVisibilidade = visibilidadeDoDocumento,
): FonteDeVisibilidade {
  let janelaVisivel = true;
  return {
    visivel: () => janelaVisivel && documento.visivel(),
    assinar: (ouvinte) => {
      const cancelarJanela = ponte.aoMudarVisibilidade((visivel) => {
        janelaVisivel = visivel;
        ouvinte();
      });
      const cancelarDocumento = documento.assinar(ouvinte);
      return () => {
        cancelarJanela();
        cancelarDocumento();
      };
    },
  };
}
