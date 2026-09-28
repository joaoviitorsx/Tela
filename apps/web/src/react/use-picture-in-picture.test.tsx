// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePictureInPicture } from './use-picture-in-picture.js';

type DocumentoPip = { pictureInPictureEnabled?: boolean; pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
const doc = document as unknown as DocumentoPip;

function videoFalso(): HTMLVideoElement {
  const v = document.createElement('video');
  (v as unknown as { requestPictureInPicture: () => Promise<unknown> }).requestPictureInPicture = vi
    .fn()
    .mockResolvedValue({});
  return v;
}

afterEach(() => {
  cleanup();
  delete doc.pictureInPictureEnabled;
  delete doc.pictureInPictureElement;
  delete doc.exitPictureInPicture;
});

describe('usePictureInPicture', () => {
  it('só existe onde o navegador tem a API', () => {
    const video = videoFalso();

    doc.pictureInPictureEnabled = false;
    expect(renderHook(() => usePictureInPicture(video)).result.current.disponivel).toBe(false);

    delete doc.pictureInPictureEnabled;
    expect(renderHook(() => usePictureInPicture(video)).result.current.disponivel).toBe(false);

    doc.pictureInPictureEnabled = true;
    expect(renderHook(() => usePictureInPicture(video)).result.current.disponivel).toBe(true);
  });

  it('sem elemento de vídeo ainda, não há botão', () => {
    doc.pictureInPictureEnabled = true;
    expect(renderHook(() => usePictureInPicture(null)).result.current.disponivel).toBe(false);
  });

  it('alternar pede a janela flutuante ao próprio <video>', () => {
    doc.pictureInPictureEnabled = true;
    const video = videoFalso();
    const { result } = renderHook(() => usePictureInPicture(video));

    act(() => result.current.alternar());

    expect(
      (video as unknown as { requestPictureInPicture: ReturnType<typeof vi.fn> }).requestPictureInPicture,
    ).toHaveBeenCalledTimes(1);
  });

  it('o estado segue os eventos do vídeo (fechar pelo X da janelinha inclui)', () => {
    doc.pictureInPictureEnabled = true;
    const video = videoFalso();
    const { result } = renderHook(() => usePictureInPicture(video));

    act(() => video.dispatchEvent(new Event('enterpictureinpicture')));
    expect(result.current.ativo).toBe(true);

    act(() => video.dispatchEvent(new Event('leavepictureinpicture')));
    expect(result.current.ativo).toBe(false);
  });

  it('com a janelinha aberta, alternar sai dela', () => {
    doc.pictureInPictureEnabled = true;
    const video = videoFalso();
    const sair = vi.fn().mockResolvedValue(undefined);
    doc.pictureInPictureElement = video;
    doc.exitPictureInPicture = sair;
    const { result } = renderHook(() => usePictureInPicture(video));

    act(() => result.current.alternar());

    expect(sair).toHaveBeenCalledTimes(1);
  });

  it('recusa do navegador não derruba a página', async () => {
    doc.pictureInPictureEnabled = true;
    const video = videoFalso();
    (video as unknown as { requestPictureInPicture: () => Promise<never> }).requestPictureInPicture = () =>
      Promise.reject(new Error('NotAllowedError'));
    const { result } = renderHook(() => usePictureInPicture(video));

    await act(async () => result.current.alternar());

    expect(result.current.ativo).toBe(false);
  });
});
