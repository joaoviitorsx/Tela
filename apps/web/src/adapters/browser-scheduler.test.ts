import { afterEach, expect, it, vi } from 'vitest';
import { makeBrowserScheduler } from './browser-scheduler.js';

afterEach(() => vi.unstubAllGlobals());

function documento(estado: 'visible' | 'hidden', pip: object | null) {
  const ouvintes = new Map<string, Set<() => void>>();
  return {
    visibilityState: estado,
    pictureInPictureElement: pip,
    addEventListener: (tipo: string, h: () => void) => {
      const set = ouvintes.get(tipo) ?? new Set();
      set.add(h);
      ouvintes.set(tipo, set);
    },
    removeEventListener: (tipo: string, h: () => void) => ouvintes.get(tipo)?.delete(h),
    disparar: (tipo: string) => ouvintes.get(tipo)?.forEach((h) => h()),
    ouvintes,
  };
}

it('aba escondida com PiP aberta conta como visível (TELA-021)', () => {
  vi.stubGlobal('document', documento('hidden', {}));
  expect(makeBrowserScheduler().isVisible()).toBe(true);
  vi.stubGlobal('document', documento('hidden', null));
  expect(makeBrowserScheduler().isVisible()).toBe(false);
});

it('entrar e sair da PiP avisa como mudança de visibilidade, e desinscreve', () => {
  const doc = documento('hidden', null);
  vi.stubGlobal('document', doc);
  let chamadas = 0;
  const parar = makeBrowserScheduler().onVisibilityChange(() => {
    chamadas += 1;
  });
  doc.disparar('enterpictureinpicture');
  doc.disparar('leavepictureinpicture');
  expect(chamadas).toBe(2);
  parar();
  expect([...doc.ouvintes.values()].every((s) => s.size === 0)).toBe(true);
});
