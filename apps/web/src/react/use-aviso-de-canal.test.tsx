// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerState } from '../core/media/viewer-session.js';
import { iconeDaFase, useAvisoDeCanal } from './use-aviso-de-canal.js';

type Status = ViewerState['status'];

let link: HTMLLinkElement;

beforeEach(() => {
  document.title = 'Tela';
  link = document.createElement('link');
  link.rel = 'icon';
  link.href = '/favicon.png';
  document.head.appendChild(link);
});

afterEach(() => {
  cleanup();
  link.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function montar(bipe = vi.fn()) {
  const hook = renderHook(
    ({ status, imagem }: { status: Status; imagem: boolean }) => useAvisoDeCanal('jv', status, imagem, bipe),
    { initialProps: { status: 'checking' as Status, imagem: false } },
  );
  return { ...hook, bipe };
}

describe('useAvisoDeCanal', () => {
  it('esperando: título e favicon de espera', () => {
    const { result } = montar();
    expect(result.current.fase).toBe('esperando');
    expect(document.title).toBe('◌ aguardando · jv');
    expect(link.href).toBe(iconeDaFase('esperando'));
  });

  it('entra no ar: título AO VIVO e favicon vermelho', () => {
    const { rerender } = montar();
    rerender({ status: 'watching', imagem: true });
    expect(document.title).toBe('● AO VIVO · jv');
    expect(link.href).toBe(iconeDaFase('ao-vivo'));
  });

  it('o canal cai: "encerrada" com a hora, e continua assim enquanto sonda', () => {
    const { result, rerender } = montar();
    rerender({ status: 'watching', imagem: true });
    rerender({ status: 'offline', imagem: false });
    expect(result.current.fase).toBe('encerrada');
    expect(result.current.terminouEm).not.toBeNull();
    expect(document.title).toBe('■ encerrada · jv');
    rerender({ status: 'connecting', imagem: false });
    expect(result.current.fase).toBe('encerrada');
  });

  it('bipa quando a imagem chega com a aba escondida e a página já teve gesto', () => {
    vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: true } });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { rerender, bipe } = montar();
    rerender({ status: 'watching', imagem: true });
    expect(bipe).toHaveBeenCalledTimes(1);
  });

  it('não bipa sem ativação do usuário, nem com a aba à vista', () => {
    const { rerender, bipe } = montar();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    rerender({ status: 'watching', imagem: true });
    expect(bipe).not.toHaveBeenCalled();

    vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: true } });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    rerender({ status: 'offline', imagem: false });
    rerender({ status: 'watching', imagem: true });
    expect(bipe).not.toHaveBeenCalled();
  });

  it('ao sair, devolve o favicon original', () => {
    const { unmount } = montar();
    unmount();
    expect(link.getAttribute('href')).toBe('/favicon.png');
  });
});
