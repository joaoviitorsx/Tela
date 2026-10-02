import { describe, expect, it } from 'vitest';
import {
  escolhaValida,
  MAXIMO_DE_FONTES,
  mapearFontes,
  respostaDeCaptura,
  tipoDaFonte,
  usaSeletorProprio,
} from './fontes-de-captura.js';

const tela = (n: number, nome = n === 0 ? 'Entire Screen' : `Screen ${n}`) => ({
  id: `screen:${n}:0`,
  name: nome,
  miniatura: `data:image/jpeg;base64,t${n}`,
  icone: null,
});
const janela = (n: number, nome: string) => ({
  id: `window:${n}:0`,
  name: nome,
  miniatura: `data:image/jpeg;base64,j${n}`,
  icone: `data:image/png;base64,i${n}`,
});

describe('tipoDaFonte', () => {
  it('lê o prefixo do id do Electron', () => {
    expect(tipoDaFonte('screen:0:0')).toBe('tela');
    expect(tipoDaFonte('window:19932:0')).toBe('janela');
    expect(tipoDaFonte('tab:1')).toBeNull();
    expect(tipoDaFonte('')).toBeNull();
  });
});

describe('mapearFontes', () => {
  it('telas primeiro, em português; janelas depois, com ícone', () => {
    const lista = mapearFontes([janela(7, 'Hades II'), tela(0), tela(1), janela(8, 'Discord')]);
    expect(lista.map((f) => [f.id, f.nome, f.tipo])).toEqual([
      ['screen:0:0', 'TELA INTEIRA', 'tela'],
      ['screen:1:0', 'TELA 1', 'tela'],
      ['window:7:0', 'Hades II', 'janela'],
      ['window:8:0', 'Discord', 'janela'],
    ]);
    expect(lista[0]?.icone).toBeNull();
    expect(lista[2]?.icone).toBe('data:image/png;base64,i7');
    expect(lista[2]?.miniatura).toBe('data:image/jpeg;base64,j7');
  });

  it('exclui a janela do próprio Tela, janelas sem título e tipos desconhecidos', () => {
    const lista = mapearFontes(
      [janela(1, 'Tela'), janela(2, '   '), { id: 'tab:3', name: 'x', miniatura: null, icone: null }, janela(4, 'Jogo')],
      new Set(['window:1:0']),
    );
    expect(lista.map((f) => f.id)).toEqual(['window:4:0']);
  });

  it('tela sem nome reconhecível ganha número; sem miniatura fica null', () => {
    const lista = mapearFontes([{ id: 'screen:5:0', name: '', miniatura: null, icone: null }]);
    expect(lista[0]).toEqual({ id: 'screen:5:0', nome: 'TELA 1', tipo: 'tela', miniatura: null, icone: null });
  });

  it('corta a listagem no máximo', () => {
    const muitas = Array.from({ length: MAXIMO_DE_FONTES + 20 }, (_, i) => janela(i, `J${i}`));
    expect(mapearFontes(muitas)).toHaveLength(MAXIMO_DE_FONTES);
  });
});

describe('escolhaValida (IPC tela:escolher-fonte)', () => {
  const listagem = new Map([
    ['screen:0:0', 1],
    ['window:7:0', 1],
  ]);
  it('um id da última listagem', () => {
    expect(escolhaValida('window:7:0', listagem)).toEqual({ id: 'window:7:0' });
  });
  it('null é cancelar', () => {
    expect(escolhaValida(null, listagem)).toEqual({ id: null });
  });
  it('id que não foi oferecido, ou que não é string: recusado', () => {
    expect(escolhaValida('window:999:0', listagem)).toBeNull();
    expect(escolhaValida('', listagem)).toBeNull();
    expect(escolhaValida(7, listagem)).toBeNull();
    expect(escolhaValida(undefined, listagem)).toBeNull();
    expect(escolhaValida({ id: 'screen:0:0' }, listagem)).toBeNull();
    expect(escolhaValida('a'.repeat(300), listagem)).toBeNull();
  });
});

describe('respostaDeCaptura (setDisplayMediaRequestHandler)', () => {
  const fonte = { id: 'screen:0:0', name: 'Entire Screen' };
  it('sem escolha: vazio, e a página recebe NotAllowedError → DENIED', () => {
    expect(respostaDeCaptura(null, 'win32', true)).toBeNull();
  });
  it('Windows + tela + áudio pedido: loopback', () => {
    expect(respostaDeCaptura({ fonte, tipo: 'tela' }, 'win32', true)).toEqual({ video: fonte, audio: 'loopback' });
  });
  it('Windows + janela: sem áudio, porque janela no Windows é muda', () => {
    expect(respostaDeCaptura({ fonte, tipo: 'janela' }, 'win32', true)).toEqual({ video: fonte });
  });
  it('Windows sem áudio pedido, e Linux sempre: só vídeo', () => {
    expect(respostaDeCaptura({ fonte, tipo: 'tela' }, 'win32', false)).toEqual({ video: fonte });
    expect(respostaDeCaptura({ fonte, tipo: 'tela' }, 'linux', true)).toEqual({ video: fonte });
  });
});

describe('usaSeletorProprio', () => {
  it('Windows sempre; Linux só fora do Wayland; macOS nunca (não é alvo)', () => {
    expect(usaSeletorProprio('win32', {})).toBe(true);
    expect(usaSeletorProprio('linux', { XDG_SESSION_TYPE: 'x11' })).toBe(true);
    expect(usaSeletorProprio('linux', {})).toBe(true);
    expect(usaSeletorProprio('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe(false);
    expect(usaSeletorProprio('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
    expect(usaSeletorProprio('linux', { WAYLAND_DISPLAY: '' })).toBe(true);
    expect(usaSeletorProprio('darwin', {})).toBe(false);
  });
});
