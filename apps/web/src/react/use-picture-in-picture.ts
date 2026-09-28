import { useCallback, useEffect, useState } from 'react';

export type PictureInPicture = {
  /** O navegador tem a API e o vídeo não a proíbe. Sem isso, o botão não existe. */
  readonly disponivel: boolean;
  readonly ativo: boolean;
  readonly alternar: () => void;
};

/**
 * Picture-in-picture de verdade, do `<video>` do espectador.
 *
 * O protótipo simulava a janelinha com um retângulo dentro da própria página,
 * que some junto com a aba. A API nativa flutua sobre o jogo do amigo, que é
 * exatamente o caso de uso: ver o stream enquanto joga o dele.
 *
 * `document.pictureInPictureEnabled` é a pergunta certa — Firefox e Safari
 * antigo respondem `false`/`undefined`, e um botão que não faz nada é pior que
 * botão nenhum. Os eventos do próprio `<video>` são a fonte da verdade do
 * estado: o usuário fecha a janelinha pelo X dela, e a página só fica sabendo
 * por eles.
 */
export function usePictureInPicture(video: HTMLVideoElement | null): PictureInPicture {
  const [ativo, setAtivo] = useState(false);

  const disponivel =
    video !== null &&
    typeof document !== 'undefined' &&
    document.pictureInPictureEnabled === true &&
    !video.disablePictureInPicture;

  useEffect(() => {
    if (video === null) return;
    const entrou = () => setAtivo(true);
    const saiu = () => setAtivo(false);
    video.addEventListener('enterpictureinpicture', entrou);
    video.addEventListener('leavepictureinpicture', saiu);
    setAtivo(document.pictureInPictureElement === video);
    return () => {
      video.removeEventListener('enterpictureinpicture', entrou);
      video.removeEventListener('leavepictureinpicture', saiu);
    };
  }, [video]);

  const alternar = useCallback(() => {
    if (video === null) return;
    if (document.pictureInPictureElement === video) {
      void document.exitPictureInPicture().catch(() => undefined);
      return;
    }
    // Recusa é normal (sem gesto, política do site): não há o que mostrar.
    void video.requestPictureInPicture().catch(() => undefined);
  }, [video]);

  return { disponivel, ativo, alternar };
}
