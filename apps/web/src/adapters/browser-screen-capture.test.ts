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

/** `getDisplayMedia` que responde, na ordem, cada item: erro (pelo nome) ou sucesso. */
function stubEmSequencia(respostas: ReadonlyArray<string | 'ok'>) {
  const chamadas: Chamada[] = [];
  const limites: unknown[] = [];
  const track = {
    kind: 'video',
    getSettings: () => ({ width: 2560, height: 1440, displaySurface: 'monitor' }),
    applyConstraints: async (c: unknown) => {
      limites.push(c);
    },
    stop: () => undefined,
  };
  let i = 0;
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: async (opts: Chamada) => {
        chamadas.push(opts);
        const r = respostas[i++] ?? 'ok';
        if (r !== 'ok') throw Object.assign(new Error('x'), { name: r });
        return { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
      },
    },
  });
  return { chamadas, limites };
}

describe('browser-screen-capture — falha técnica tenta de novo com o pedido mínimo', () => {
  it('a segunda tentativa vale: captura sai, limites vão na trilha, o nome do erro fica', async () => {
    const { chamadas, limites } = stubEmSequencia(['NotReadableError', 'ok']);
    const captura = makeBrowserScreenCapture();
    const r = await captura.request(PEDIDO);
    expect(r.ok).toBe(true);
    expect(chamadas[1]).toEqual({ video: true, audio: true });
    expect(limites).toEqual([{ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } }]);
    expect(captura.ultimaFalha?.()).toBe('NotReadableError>ok');
  });

  it('as duas falham: FAILED com os dois nomes', async () => {
    stubEmSequencia(['AbortError', 'NotReadableError']);
    const captura = makeBrowserScreenCapture();
    expect(await captura.request(PEDIDO)).toEqual({ ok: false, error: 'FAILED' });
    expect(captura.ultimaFalha?.()).toBe('AbortError>NotReadableError');
  });

  it('cancelar na segunda tentativa é cancelar', async () => {
    stubEmSequencia(['AbortError', 'NotAllowedError']);
    expect(await makeBrowserScreenCapture().request(PEDIDO)).toEqual({ ok: false, error: 'DENIED' });
  });

  it('cancelar na primeira não tenta de novo', async () => {
    const { chamadas } = stubEmSequencia(['NotAllowedError']);
    expect(await makeBrowserScreenCapture().request(PEDIDO)).toEqual({ ok: false, error: 'DENIED' });
    expect(chamadas).toHaveLength(1);
  });
});

describe('browser-screen-capture — o som da janela, sem a call', () => {
  it('pede windowAudio: window quando quer som (Chrome 141+), exclude quando não', async () => {
    const { chamadas } = stubGetDisplayMedia();
    await makeBrowserScreenCapture().request(PEDIDO);
    expect(chamadas[0]?.['windowAudio']).toBe('window');
    await makeBrowserScreenCapture().request({ ...PEDIDO, systemAudio: false });
    expect(chamadas[1]?.['windowAudio']).toBe('exclude');
  });
});

describe('chromeComSomDaJanela', () => {
  it('Chrome 141+ (pela marca ou pelo user agent)', async () => {
    const { chromeComSomDaJanela } = await import('./browser-screen-capture.js');
    expect(chromeComSomDaJanela({ userAgentData: { brands: [{ brand: 'Google Chrome', version: '154' }] } })).toBe(true);
    expect(chromeComSomDaJanela({ userAgentData: { brands: [{ brand: 'Chromium', version: '140' }] } })).toBe(false);
    expect(chromeComSomDaJanela({ userAgent: 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36' })).toBe(true);
    expect(chromeComSomDaJanela({ userAgent: 'Mozilla/5.0 Firefox/140.0' })).toBe(false);
  });
});
