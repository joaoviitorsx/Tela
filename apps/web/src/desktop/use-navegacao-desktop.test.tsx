// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { caminhoInterno, itemAtivo, trilhoTravado, useNavegacaoDesktop } from './use-navegacao-desktop.js';

function irViaRoteador(caminho: string) {
  // O que `useRoute().navigate` faz: pushState e o mesmo evento do botão voltar.
  window.history.pushState({}, '', caminho);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

beforeEach(() => window.history.replaceState({}, '', '/'));
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('trilhoTravado / itemAtivo', () => {
  it('trava só na transmissão', () => {
    expect(trilhoTravado('/transmitir')).toBe(true);
    expect(trilhoTravado('/')).toBe(false);
    expect(trilhoTravado('/recuperar')).toBe(false);
    expect(trilhoTravado('/joao')).toBe(false);
  });

  it('acende TRANSMITIR na home e ao vivo, ASSISTIR num canal, CANAL em /recuperar, nada no resto', () => {
    expect(itemAtivo('/')).toBe('transmitir');
    expect(itemAtivo('/transmitir')).toBe('transmitir');
    expect(itemAtivo('/recuperar')).toBe('canal');
    expect(itemAtivo('/joao')).toBe('assistir');
    expect(itemAtivo('/x')).toBeNull();
  });
});

describe('caminhoInterno', () => {
  const origem = 'http://localhost:5174';
  it('devolve o caminho de links da própria origem, com busca e fragmento', () => {
    expect(caminhoInterno('http://localhost:5174/recuperar', origem)).toBe('/recuperar');
    expect(caminhoInterno('/joao?abertura=0#x', origem)).toBe('/joao?abertura=0#x');
  });
  it('deixa passar o que sai do app', () => {
    expect(caminhoInterno('https://tela.gg/joao', origem)).toBeNull();
    expect(caminhoInterno('mailto:x@y', origem)).toBeNull();
  });
});

describe('useNavegacaoDesktop', () => {
  it('troca a rota pelo mesmo popstate que o roteador ouve', () => {
    const { result } = renderHook(() => useNavegacaoDesktop());
    expect(result.current.caminho).toBe('/');
    expect(result.current.travado).toBe(false);

    act(() => result.current.irPara('/recuperar'));

    expect(window.location.pathname).toBe('/recuperar');
    expect(result.current.caminho).toBe('/recuperar');
  });

  it('acompanha a navegação feita pelo roteador', () => {
    const { result } = renderHook(() => useNavegacaoDesktop());

    act(() => irViaRoteador('/transmitir'));

    expect(result.current.caminho).toBe('/transmitir');
    expect(result.current.travado).toBe(true);
  });

  it('ao vivo, não sai de /transmitir por nada', () => {
    const { result } = renderHook(() => useNavegacaoDesktop());
    act(() => irViaRoteador('/transmitir'));

    act(() => result.current.irPara('/'));
    act(() => result.current.irPara('/recuperar'));

    expect(window.location.pathname).toBe('/transmitir');
    expect(result.current.travado).toBe(true);
  });

  it('um <a> interno vira troca de rota em vez de recarregar a página', () => {
    const { result } = renderHook(() => useNavegacaoDesktop());
    const a = document.createElement('a');
    a.href = '/recuperar';
    document.body.append(a);

    const evento = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      a.dispatchEvent(evento);
    });

    expect(evento.defaultPrevented).toBe(true);
    expect(result.current.caminho).toBe('/recuperar');
  });

  it('um <a> externo, com download ou com modificador segue o navegador', () => {
    renderHook(() => useNavegacaoDesktop());
    const externo = document.createElement('a');
    externo.href = 'https://tela.gg/joao';
    const download = document.createElement('a');
    download.href = '/tela-audio-linux.sh';
    download.setAttribute('download', 'x.sh');
    const interno = document.createElement('a');
    interno.href = '/recuperar';
    document.body.append(externo, download, interno);

    const clique = (el: HTMLElement, init: MouseEventInit = {}) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };

    expect(clique(externo)).toBe(false);
    expect(clique(download)).toBe(false);
    expect(clique(interno, { ctrlKey: true })).toBe(false);
  });

  it('para de ouvir cliques ao desmontar', () => {
    const { unmount } = renderHook(() => useNavegacaoDesktop());
    unmount();
    const a = document.createElement('a');
    a.href = '/recuperar';
    document.body.append(a);

    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
  });
});
