import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeBrowserScreenCapture } from './browser-screen-capture.js';

/**
 * Este arquivo existe por causa de UMA linha que não fazia nada.
 *
 * `displaySurface: 'monitor'` estava no nível de cima do
 * `DisplayMediaStreamOptions`, que tem só `audio` e `video`. Membro
 * desconhecido é descartado em silêncio, e o `as DisplayMediaStreamOptions` do
 * adapter é exatamente o que impedia o TypeScript de acusar. O seletor abria
 * onde o Chrome quisesse.
 *
 * A cascata era cara: o usuário caindo na aba "Janela" compartilhava o jogo em
 * 1280×720, e a partir daí todo o orçamento era calculado em cima de
 * 1920×1080 — o espectador recebia 720p esticado com a UI escrita `1080p60`.
 * No Windows, sem tela inteira também não vem áudio do sistema.
 *
 * Nenhum teste podia pegar isso olhando o resultado: a captura funciona, só
 * abre na aba errada. Só olhando o que foi PEDIDO.
 */
type Chamada = { video?: Record<string, unknown>; [k: string]: unknown };

function stubGetDisplayMedia(): { chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const track = {
    kind: 'video',
    getSettings: () => ({ width: 1920, height: 1080, displaySurface: 'monitor' }),
    stop: () => undefined,
  };
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: async (opts: Chamada) => {
        chamadas.push(opts);
        return {
          getVideoTracks: () => [track],
          getAudioTracks: () => [],
          getTracks: () => [track],
        };
      },
    },
  });
  return { chamadas };
}

afterEach(() => vi.unstubAllGlobals());

const PEDIDO = { width: 1920, height: 1080, frameRate: 60, systemAudio: true };

describe('browser-screen-capture — o que é PEDIDO ao navegador', () => {
  it('displaySurface vai DENTRO de video, onde ele é constraint', async () => {
    const { chamadas } = stubGetDisplayMedia();
    await makeBrowserScreenCapture().request(PEDIDO);

    const opts = chamadas[0]!;
    // O lugar certo: `MediaTrackConstraintSet`.
    expect(opts.video?.['displaySurface']).toBe('monitor');
    // E o lugar errado tem que ficar vazio, senão a linha volta a não valer.
    expect(opts['displaySurface']).toBeUndefined();
  });

  it('mantém crop-and-scale e o teto de resolução no lugar certo', async () => {
    const { chamadas } = stubGetDisplayMedia();
    await makeBrowserScreenCapture().request(PEDIDO);

    const video = chamadas[0]!.video!;
    expect(video['resizeMode']).toBe('crop-and-scale');
    expect(video['width']).toMatchObject({ max: 1920 });
    expect(video['frameRate']).toMatchObject({ max: 60 });
  });

  it('os TRÊS que são mesmo de DisplayMediaStreamOptions ficam no topo', async () => {
    const { chamadas } = stubGetDisplayMedia();
    await makeBrowserScreenCapture().request(PEDIDO);

    // Só o `displaySurface` estava no lugar errado; estes três estão certos.
    const opts = chamadas[0]!;
    expect(opts['surfaceSwitching']).toBe('include');
    expect(opts['selfBrowserSurface']).toBe('exclude');
    expect(opts['systemAudio']).toBe('include');
  });
});
