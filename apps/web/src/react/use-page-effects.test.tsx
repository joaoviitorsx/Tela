// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alvoTemTeclaPropria, useHotkeys } from './use-page-effects.js';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function tecla(alvo: EventTarget, key: string, extra: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  alvo.dispatchEvent(ev);
  return ev;
}

describe('alvoTemTeclaPropria', () => {
  it('reconhece botão, link, campo, slider e resumo', () => {
    for (const html of [
      '<button></button>',
      '<a href="#x">x</a>',
      '<input />',
      '<textarea></textarea>',
      '<select></select>',
      '<details><summary>s</summary></details>',
      '<div role="slider"></div>',
      '<div role="radio"></div>',
    ]) {
      document.body.innerHTML = html;
      const alvo = document.body.querySelector('button, a, input, textarea, select, summary, [role]');
      expect(alvoTemTeclaPropria(alvo), html).toBe(true);
    }
  });

  it('não reconhece o palco nem o body', () => {
    document.body.innerHTML = '<main></main>';
    expect(alvoTemTeclaPropria(document.querySelector('main'))).toBe(false);
    expect(alvoTemTeclaPropria(document.body)).toBe(false);
    expect(alvoTemTeclaPropria(null)).toBe(false);
  });
});

describe('useHotkeys', () => {
  it('age no palco e cancela o padrão', () => {
    const acao = vi.fn();
    renderHook(() => useHotkeys({ m: acao }));
    document.body.innerHTML = '<main></main>';
    const ev = tecla(document.querySelector('main') as HTMLElement, 'm');
    expect(acao).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('cede o Espaço e as teclas ao botão focado', () => {
    const acao = vi.fn();
    renderHook(() => useHotkeys({ ' ': acao, '+': acao }));
    document.body.innerHTML = '<button id="b"></button>';
    const ev = tecla(document.getElementById('b') as HTMLElement, ' ');
    tecla(document.getElementById('b') as HTMLElement, '+');
    expect(acao).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('não rouba as setas de um slider', () => {
    const acao = vi.fn();
    renderHook(() => useHotkeys({ arrowup: acao }));
    document.body.innerHTML = '<div role="slider" id="s"></div>';
    tecla(document.getElementById('s') as HTMLElement, 'ArrowUp');
    expect(acao).not.toHaveBeenCalled();
  });

  it('ignora combinações com Ctrl, Alt e Meta', () => {
    const acao = vi.fn();
    renderHook(() => useHotkeys({ f: acao }));
    tecla(document.body, 'f', { ctrlKey: true });
    tecla(document.body, 'f', { metaKey: true });
    tecla(document.body, 'f', { altKey: true });
    expect(acao).not.toHaveBeenCalled();
  });
});
