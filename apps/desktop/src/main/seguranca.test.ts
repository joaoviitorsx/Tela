import { describe, expect, it } from 'vitest';
import {
  decidirJanelaNova,
  origemDe,
  origensPermitidas,
  permissaoConcedida,
  podeNavegar,
  urlExternaPermitida,
  urlParaAbrirNoNavegador,
} from './seguranca.js';

const SO_APP = origensPermitidas(undefined);
const COM_DEV = origensPermitidas('http://localhost:5174/desktop.html');

describe('origemDe', () => {
  it('monta a origem do esquema próprio, que a plataforma devolve como "null"', () => {
    expect(origemDe('app://tela/transmitir?x=1')).toBe('app://tela');
    expect(new URL('app://tela/transmitir').origin).toBe('null');
  });
  it('mantém a porta e descarta caminho, usuário e fragmento', () => {
    expect(origemDe('http://user:pw@localhost:5174/desktop.html#a')).toBe('http://localhost:5174');
    expect(origemDe('https://tela.gg/jv')).toBe('https://tela.gg');
  });
  it('sem host não há origem', () => {
    expect(origemDe('about:blank')).toBeNull();
    expect(origemDe('data:text/html,oi')).toBeNull();
    expect(origemDe('javascript:alert(1)')).toBeNull();
    expect(origemDe('')).toBeNull();
    expect(origemDe('lixo')).toBeNull();
  });
});

describe('origensPermitidas', () => {
  it('sem dev, só o app', () => {
    expect([...SO_APP]).toEqual(['app://tela']);
  });
  it('com dev, a origem do Vite entra', () => {
    expect([...COM_DEV]).toEqual(['app://tela', 'http://localhost:5174']);
  });
  it('URL de dev inválida é ignorada, não vira origem', () => {
    expect([...origensPermitidas('isso não é url')]).toEqual(['app://tela']);
    expect([...origensPermitidas('')]).toEqual(['app://tela']);
  });
});

describe('podeNavegar', () => {
  it('dentro da interface', () => {
    expect(podeNavegar('app://tela/recuperar', SO_APP)).toBe(true);
    expect(podeNavegar('http://localhost:5174/jv', COM_DEV)).toBe(true);
  });
  it('para fora, nunca — nem para o site, nem para o Vite sem dev', () => {
    expect(podeNavegar('https://tela.gg/jv', SO_APP)).toBe(false);
    expect(podeNavegar('http://localhost:5174/jv', SO_APP)).toBe(false);
    expect(podeNavegar('app://outro/x', SO_APP)).toBe(false);
    expect(podeNavegar('file:///etc/passwd', SO_APP)).toBe(false);
    expect(podeNavegar('about:blank', SO_APP)).toBe(false);
  });
  it('origem exige o host exato, não prefixo', () => {
    expect(podeNavegar('app://tela.evil/x', SO_APP)).toBe(false);
    expect(podeNavegar('http://localhost:51744/x', COM_DEV)).toBe(false);
  });
});

describe('urlExternaPermitida', () => {
  it('só https, normalizado', () => {
    expect(urlExternaPermitida('https://tela.gg/jv')).toBe('https://tela.gg/jv');
    expect(urlExternaPermitida('HTTPS://Tela.GG')).toBe('https://tela.gg/');
  });
  it('recusa tudo que não é https', () => {
    for (const url of [
      'http://tela.gg/jv',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'tela://assistir/jv',
      'app://tela/x',
      'mailto:a@b.c',
      'https://',
      '',
      'tela.gg/jv',
    ]) {
      expect(urlExternaPermitida(url), url).toBeNull();
    }
  });
  it('recusa o que não é string e o que é grande demais', () => {
    expect(urlExternaPermitida(undefined)).toBeNull();
    expect(urlExternaPermitida(null)).toBeNull();
    expect(urlExternaPermitida(42)).toBeNull();
    expect(urlExternaPermitida({ href: 'https://tela.gg' })).toBeNull();
    expect(urlExternaPermitida(`https://tela.gg/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('urlParaAbrirNoNavegador (IPC tela:abrir-no-navegador)', () => {
  it('frame da interface + https: abre', () => {
    expect(urlParaAbrirNoNavegador('app://tela/transmitir', 'https://tela.gg/jv', SO_APP)).toBe(
      'https://tela.gg/jv',
    );
  });
  it('frame de fora da interface: ignora, mesmo com URL boa', () => {
    expect(urlParaAbrirNoNavegador('https://tela.gg/jv', 'https://tela.gg/jv', SO_APP)).toBeNull();
    expect(urlParaAbrirNoNavegador(undefined, 'https://tela.gg/jv', SO_APP)).toBeNull();
    expect(urlParaAbrirNoNavegador('http://localhost:5174/x', 'https://tela.gg/jv', SO_APP)).toBeNull();
  });
  it('frame bom, URL ruim: ignora', () => {
    expect(urlParaAbrirNoNavegador('app://tela/x', 'file:///etc/passwd', SO_APP)).toBeNull();
    expect(urlParaAbrirNoNavegador('app://tela/x', 7, SO_APP)).toBeNull();
  });
});

describe('decidirJanelaNova', () => {
  it('https vai para o navegador, o resto é negado', () => {
    expect(decidirJanelaNova('https://tela.gg/jv')).toBe('abrir-no-navegador');
    expect(decidirJanelaNova('app://tela/jv')).toBe('negar');
    expect(decidirJanelaNova('http://tela.gg/jv')).toBe('negar');
    expect(decidirJanelaNova('about:blank')).toBe('negar');
  });
});

describe('permissaoConcedida', () => {
  const concedidas = ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'];
  it('as quatro da interface, da origem da interface', () => {
    for (const p of concedidas) {
      expect(permissaoConcedida(p, 'app://tela/transmitir', SO_APP), p).toBe(true);
      expect(permissaoConcedida(p, 'http://localhost:5174/desktop.html', COM_DEV), p).toBe(true);
    }
  });
  it('as mesmas, de outra origem: negadas', () => {
    for (const p of concedidas) {
      expect(permissaoConcedida(p, 'https://tela.gg/jv', SO_APP), p).toBe(false);
      expect(permissaoConcedida(p, 'http://localhost:5174/desktop.html', SO_APP), p).toBe(false);
      expect(permissaoConcedida(p, undefined, SO_APP), p).toBe(false);
    }
  });
  it('qualquer outra permissão: negada, mesmo da interface', () => {
    for (const p of [
      'notifications',
      'geolocation',
      'midi',
      'midiSysex',
      'pointerLock',
      'openExternal',
      'clipboard-read',
      'window-management',
      'usb',
      'serial',
      'hid',
      'idle-detection',
      'keyboardLock',
      'speaker-selection',
      'unknown',
      '',
    ]) {
      expect(permissaoConcedida(p, 'app://tela/transmitir', SO_APP), p).toBe(false);
    }
  });
});
