import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '../core/domain/result.js';
import type { CaptureRequest, CaptureResult, ScreenCapture } from '../core/ports/screen-capture.js';
import { semSomNaCaptura } from './som-na-captura.js';

const PEDIDO: CaptureRequest = { width: 1920, height: 1080, frameRate: 60, systemAudio: true };
const video = {} as MediaStreamTrack;

function montar(resultado: CaptureResult | 'negado' = { video, audio: null, surface: 'monitor' }) {
  const request = vi.fn(() => Promise.resolve(resultado === 'negado' ? err('DENIED' as const) : ok(resultado)));
  const tela: ScreenCapture = { isSupported: () => true, request };
  return { tela: semSomNaCaptura(tela), request };
}

describe('semSomNaCaptura', () => {
  it('nunca pede áudio à tela: o loopback do sistema traria a call junto', async () => {
    const { tela, request } = montar();
    await tela.request(PEDIDO);
    expect(request).toHaveBeenCalledWith({ ...PEDIDO, systemAudio: false });
  });

  it('uma trilha de áudio que viesse mesmo assim é parada e descartada', async () => {
    const audio = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const { tela } = montar({ video, audio, surface: 'monitor' });
    const r = await tela.request(PEDIDO);
    expect(r.ok && r.value.audio).toBeNull();
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });

  it('janela não dispara o aviso de "sem áudio": no app o som não depende do que se captura', async () => {
    const { tela } = montar({ video, audio: null, surface: 'window' });
    const r = await tela.request(PEDIDO);
    expect(r.ok && r.value.surface).toBe('desconhecido');
    expect(r.ok && r.value.video).toBe(video);
  });

  it('repassa o erro e isSupported', async () => {
    const { tela } = montar('negado');
    expect((await tela.request(PEDIDO)).ok).toBe(false);
    expect(tela.isSupported()).toBe(true);
  });
});
