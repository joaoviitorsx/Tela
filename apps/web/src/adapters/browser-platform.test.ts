import { describe, expect, it } from 'vitest';
import { makeBrowserPlatform } from './browser-platform.js';

/**
 * A detecção de sistema é o que decide se o usuário recebe a instrução certa
 * sobre áudio — e áudio errado é a diferença entre uma transmissão e uma
 * transmissão muda que ninguém sabe explicar.
 */
function comNavigator(valor: unknown, corpo: () => void): void {
  const original = Reflect.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: valor, configurable: true });
  try {
    corpo();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}

describe('detecção de plataforma', () => {
  it('Windows: o áudio vem junto com a tela', () => {
    comNavigator({ userAgentData: { platform: 'Windows' } }, () => {
      const p = makeBrowserPlatform();
      expect(p.osName()).toBe('windows');
      expect(p.systemAudio()).toBe('display-media');
    });
  });

  it('Linux: precisa de sink virtual', () => {
    comNavigator({ userAgentData: { platform: 'Linux' } }, () => {
      const p = makeBrowserPlatform();
      expect(p.osName()).toBe('linux');
      expect(p.systemAudio()).toBe('monitor-device');
    });
  });

  it('macOS: sem suporte sem driver de terceiro', () => {
    comNavigator({ userAgentData: { platform: 'macOS' } }, () => {
      expect(makeBrowserPlatform().systemAudio()).toBe('unsupported');
    });
  });

  it('cai para o userAgent quando userAgentData não existe (Firefox, Safari)', () => {
    comNavigator({ userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64)' }, () => {
      expect(makeBrowserPlatform().osName()).toBe('linux');
    });

    comNavigator({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, () => {
      expect(makeBrowserPlatform().osName()).toBe('windows');
    });
  });

  it('sistema desconhecido NÃO promete áudio', () => {
    // Prometer e entregar silêncio é pior que avisar que não dá.
    comNavigator({ userAgent: 'algo bem estranho' }, () => {
      const p = makeBrowserPlatform();
      expect(p.osName()).toBe('desconhecido');
      expect(p.systemAudio()).toBe('unsupported');
    });
  });

  it('não quebra sem navigator nenhum', () => {
    comNavigator(undefined, () => {
      expect(() => makeBrowserPlatform().osName()).not.toThrow();
    });
  });
});
