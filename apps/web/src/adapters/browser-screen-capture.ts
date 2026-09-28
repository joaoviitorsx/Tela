import type {
  CaptureError,
  CaptureSurface,
  ScreenCapture,
} from '../core/ports/screen-capture.js';

/**
 * `getDisplayMedia` com as opções que importam.
 *
 * `contentHint` NÃO é setado aqui — é responsabilidade da sessão em `core/`,
 * porque é regra de produto (R5) e precisa valer também no app nativo, onde
 * este adapter não existe.
 */
export function makeBrowserScreenCapture(): ScreenCapture {
  return {
    isSupported() {
      return (
        typeof navigator !== 'undefined' &&
        typeof navigator.mediaDevices?.getDisplayMedia === 'function'
      );
    },

    async request(options) {
      if (!this.isSupported()) throw 'UNSUPPORTED' satisfies CaptureError;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: options.width, max: options.width },
            height: { ideal: options.height, max: options.height },
            frameRate: { ideal: options.frameRate, max: options.frameRate },
            /**
             * Deixa o navegador reduzir a resolução DENTRO do pipeline de
             * captura, normalmente na GPU.
             *
             * Sem isto, um monitor 1440p ou 4K entrega quadros em resolução
             * nativa e o redimensionamento acontece depois — trabalho a mais
             * por quadro, 60 vezes por segundo, na mesma máquina que está
             * rodando o jogo.
             */
            resizeMode: 'crop-and-scale',

            /**
             * Abre o seletor já na aba de TELA INTEIRA.
             *
             * Estava no nível de cima, fora de `video`, onde NÃO É MEMBRO de
             * `DisplayMediaStreamOptions` — o dicionário tem só `audio` e
             * `video`. Membro desconhecido é descartado em silêncio, e o `as`
             * lá embaixo é exatamente o que impedia o TypeScript de acusar.
             * `displaySurface` é constraint (`MediaTrackConstraintSet`), então
             * o lugar dele é aqui dentro.
             *
             * A linha não fazia nada, e a cascata era cara: o usuário caía na
             * aba "Janela", compartilhava o jogo em 1280×720, e a partir daí
             * todo o orçamento era calculado em cima de 1920×1080 — teto útil
             * de 24,9 Mbps para um quadro de 0,92 Mpx. O espectador recebia
             * 720p esticado com a UI escrita `1080p60`. No Windows, sem tela
             * inteira também não vem áudio do sistema, que é o outro motivo
             * pelo qual esta linha existe.
             */
            displaySurface: 'monitor',
          },
          /**
           * Windows/Chrome entrega áudio do sistema por aqui. Linux e macOS
           * ignoram e o áudio vem por trilha separada.
           *
           * Com o mesmo contrato do caminho Linux: nada de processamento de
           * VOZ em som de jogo (§6.3). Cancelamento de eco apagaria o próprio
           * jogo, supressão de ruído trataria efeito como ruído, ganho
           * automático achataria a dinâmica. É pedido, não garantia — a sessão
           * confere `getSettings()` e registra o que veio.
           */
          audio: options.systemAudio
            ? {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              }
            : false,

          /**
           * Abre o seletor já na aba de TELA INTEIRA.
           *
           * É o que o produto quer (o jogo está na tela, não numa aba) e é
           * pré-requisito do áudio do sistema no Windows. Era o passo que todo
           * mundo esquecia; agora ele é o padrão em vez de uma instrução.
           */
          // Não padronizados, suportados em Chromium. Estes TRÊS são de fato
          // membros de `DisplayMediaStreamOptions`; só o `displaySurface`
          // estava no lugar errado, e ele subiu para dentro de `video`.
          surfaceSwitching: 'include',
          selfBrowserSurface: 'exclude',
          systemAudio: options.systemAudio ? 'include' : 'exclude',
        } as DisplayMediaStreamOptions);
      } catch {
        // O usuário fechar o picker cai aqui. É fluxo normal, não bug.
        throw 'DENIED' satisfies CaptureError;
      }

      const video = stream.getVideoTracks()[0];
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        throw 'NO_TRACK' satisfies CaptureError;
      }

      return {
        video,
        audio: stream.getAudioTracks()[0] ?? null,
        surface: surfaceOf(video),
      };
    },
  };
}

/** O que o usuário escolheu de fato, para a UI poder avisar quando não bate. */
function surfaceOf(track: MediaStreamTrack): CaptureSurface {
  const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
  switch (settings.displaySurface) {
    case 'monitor':
      return 'monitor';
    case 'window':
      return 'window';
    case 'browser':
      return 'browser';
    default:
      return 'desconhecido';
  }
}
