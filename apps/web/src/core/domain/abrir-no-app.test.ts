import { describe, expect, it } from 'vitest';
import {
  type AmbienteDoNavegador,
  decidirTentativa,
  haAppParaEsteNavegador,
  linkDoApp,
  ofereceAbrirNoApp,
} from './abrir-no-app.js';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const amb = (p: Partial<AmbienteDoNavegador> = {}): AmbienteDoNavegador => ({
  userAgent: UA.chromeWin,
  plataforma: null,
  dentroDoApp: false,
  paginaEmFoco: true,
  automatizado: false,
  ...p,
});

describe('haAppParaEsteNavegador', () => {
  it('Windows e Linux de mesa, em Chrome, Edge e Firefox', () => {
    for (const ua of [UA.chromeWin, UA.edgeWin, UA.firefoxWin, UA.firefoxLinux, UA.chromeLinux]) {
      expect(haAppParaEsteNavegador({ userAgent: ua, plataforma: null })).toBe(true);
    }
  });
  it('celular, Safari, Mac e ChromeOS não têm app', () => {
    for (const ua of [UA.chromeAndroid, UA.safariIphone, UA.safariMac, UA.chromeMac, UA.chromeOs]) {
      expect(haAppParaEsteNavegador({ userAgent: ua, plataforma: null })).toBe(false);
    }
  });
  it('userAgentData.platform vence o User-Agent quando existe', () => {
    expect(haAppParaEsteNavegador({ userAgent: UA.chromeWin, plataforma: 'Windows' })).toBe(true);
    expect(haAppParaEsteNavegador({ userAgent: UA.chromeLinux, plataforma: 'Linux' })).toBe(true);
    expect(haAppParaEsteNavegador({ userAgent: UA.chromeMac, plataforma: 'macOS' })).toBe(false);
    expect(haAppParaEsteNavegador({ userAgent: UA.chromeLinux, plataforma: 'Android' })).toBe(false);
  });
});

describe('decidirTentativa', () => {
  it('tenta em Windows/Linux, fora do app, sem marca de "sem app", com foco', () => {
    expect(decidirTentativa(amb(), false)).toEqual({ tentar: true });
    expect(decidirTentativa(amb({ userAgent: UA.firefoxLinux }), false)).toEqual({ tentar: true });
  });
  it('não tenta dentro do próprio app', () => {
    expect(decidirTentativa(amb({ dentroDoApp: true }), false)).toEqual({ tentar: false, motivo: 'sem-app' });
  });
  it('não tenta no celular, no Safari nem no Mac', () => {
    for (const userAgent of [UA.chromeAndroid, UA.safariIphone, UA.safariMac]) {
      expect(decidirTentativa(amb({ userAgent }), false)).toEqual({ tentar: false, motivo: 'sem-app' });
    }
  });
  it('não tenta de novo quando o aparelho já disse que não tem app', () => {
    expect(decidirTentativa(amb(), true)).toEqual({ tentar: false, motivo: 'ja-sem-app' });
  });
  it('navegador dirigido por teste não tenta: não atrasa as medições', () => {
    expect(decidirTentativa(amb({ automatizado: true }), false)).toEqual({ tentar: false, motivo: 'automatizado' });
  });
  it('sem foco não dá para observar: pula, sem concluir que não há app', () => {
    expect(decidirTentativa(amb({ paginaEmFoco: false }), false)).toEqual({ tentar: false, motivo: 'sem-foco' });
  });
});

describe('ofereceAbrirNoApp / linkDoApp', () => {
  it('o botão manual aparece mesmo com a marca "sem app", e some no app e no celular', () => {
    expect(ofereceAbrirNoApp(amb())).toBe(true);
    expect(ofereceAbrirNoApp(amb({ dentroDoApp: true }))).toBe(false);
    expect(ofereceAbrirNoApp(amb({ userAgent: UA.chromeAndroid }))).toBe(false);
  });
  it('o link é o do esquema registrado', () => {
    expect(linkDoApp('joao')).toBe('tela://assistir/joao');
  });
});
