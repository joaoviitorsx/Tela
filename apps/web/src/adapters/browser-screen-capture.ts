import { err, ok } from '../core/domain/result.js';
import type { CaptureSurface, ScreenCapture } from '../core/ports/screen-capture.js';

/**
 * `getDisplayMedia` com as opções que importam.
 *
 * `contentHint` NÃO é setado aqui — é responsabilidade da sessão em `core/`,
 * porque é regra de produto (R5) e precisa valer também no app nativo, onde
 * este adapter não existe.
 */
/** Só o nome, e só letras: a mensagem pode trazer nome de janela ou caminho. */
function nomeDoErro(error: unknown): string {
  const nome = error instanceof Error ? error.name : '';
  return /^[A-Za-z]{1,40}$/.test(nome) ? nome : 'Desconhecido';
}

/** Os limites que o pedido mínimo deixou de fora, aplicados na trilha. Falhar aqui não derruba a captura. */
async function limitar(stream: MediaStream, options: { width: number; height: number; frameRate: number }): Promise<void> {
  const video = stream.getVideoTracks()[0];
  if (video === undefined) return;
  try {
    await video.applyConstraints({
      width: { max: options.width },
      height: { max: options.height },
      frameRate: { max: options.frameRate },
    });
  } catch {
    // Fica na resolução que o navegador deu; o encoder reduz pixel se precisar.
  }
}

export function makeBrowserScreenCapture(): ScreenCapture {
  let ultimaFalha: string | null = null;
  return {
    isSupported() {
      return (
        typeof navigator !== 'undefined' &&
        typeof navigator.mediaDevices?.getDisplayMedia === 'function'
      );
    },

    ultimaFalha: () => ultimaFalha,

    async request(options) {
      if (!this.isSupported()) return err('UNSUPPORTED');
      ultimaFalha = null;

      const audio = options.systemAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: options.width, max: options.width },
            height: { ideal: options.height, max: options.height },
            frameRate: { ideal: options.frameRate, max: options.frameRate },
            resizeMode: 'crop-and-scale',

            displaySurface: 'monitor',
          },
          audio,

          // Não padronizados, suportados em Chromium. Estes TRÊS são de fato
          // membros de `DisplayMediaStreamOptions`; só o `displaySurface`
          // estava no lugar errado, e ele subiu para dentro de `video`.
          surfaceSwitching: 'include',
          selfBrowserSurface: 'exclude',
          systemAudio: options.systemAudio ? 'include' : 'exclude',
        } as DisplayMediaStreamOptions);
      } catch (error) {
        /*
          `NotAllowedError` é a pessoa: fechou o seletor ou negou a permissão.
          O resto é técnico — `NotReadableError` (outro programa segurando a
          tela, portal do Wayland), `AbortError`, `NotFoundError`. Tratar tudo
          como cancelamento mandava quem não cancelou nada tentar de novo sem
          saber que o problema não era ele.
        */
        const nome = nomeDoErro(error);
        if (nome === 'NotAllowedError') return err('DENIED');
        if (nome === 'NotSupportedError') return err('UNSUPPORTED');
        /*
          Falha técnica em 0,6 s, antes de dar tempo de escolher a tela (relato
          de 02/10, Chrome 152): o pedido nem chegou ao seletor. Os membros
          não padronizados e as restrições são o que muda entre versões e
          sistemas — então tenta UMA vez com o pedido mínimo e aplica os
          limites depois, na trilha. Se o motivo era outro, falha igual, e o
          diagnóstico leva os dois nomes.
        */
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: options.systemAudio });
          await limitar(stream, options);
        } catch (segundo) {
          const segundoNome = nomeDoErro(segundo);
          ultimaFalha = segundoNome === nome ? nome : `${nome}>${segundoNome}`;
          if (segundoNome === 'NotAllowedError') return err('DENIED');
          return err('FAILED');
        }
        ultimaFalha = `${nome}>ok`;
      }

      const video = stream.getVideoTracks()[0];
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        return err('FAILED');
      }

      return ok({
        video,
        audio: stream.getAudioTracks()[0] ?? null,
        surface: surfaceOf(video),
      });
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
