import { describe, expect, it } from 'vitest';
import {
  ARGUMENTO_OCULTO,
  argumentoDoExec,
  conteudoDoAutostart,
  executavelDoAutostart,
  iniciaOculto,
  pastaDoAutostart,
} from './autostart.js';

describe('autostart', () => {
  it('abre oculto só com o argumento', () => {
    expect(iniciaOculto(['tela', ARGUMENTO_OCULTO])).toBe(true);
    expect(iniciaOculto(['tela'])).toBe(false);
  });

  it('a pasta segue TELA_USERDATA, depois XDG_CONFIG_HOME, depois ~/.config', () => {
    expect(pastaDoAutostart({ TELA_USERDATA: '/tmp/u', XDG_CONFIG_HOME: '/x' }, '/home/a')).toBe('/tmp/u/autostart');
    expect(pastaDoAutostart({ XDG_CONFIG_HOME: '/x' }, '/home/a')).toBe('/x/autostart');
    expect(pastaDoAutostart({}, '/home/a')).toBe('/home/a/.config/autostart');
    expect(pastaDoAutostart({ XDG_CONFIG_HOME: '' }, '/home/a')).toBe('/home/a/.config/autostart');
  });

  it('o .desktop abre escondido e não tem captura no comando', () => {
    const texto = conteudoDoAutostart(['/opt/Tela/tela']);
    expect(texto).toContain('[Desktop Entry]');
    expect(texto).toContain('Exec=/opt/Tela/tela --oculto\n');
    expect(texto).toContain('Type=Application');
    expect(texto.endsWith('\n')).toBe(true);
  });

  it('caminho com espaço e caracteres reservados vai entre aspas, escapado', () => {
    expect(argumentoDoExec('/home/a b/Tela')).toBe('"/home/a b/Tela"');
    expect(argumentoDoExec('/a/$x"y')).toBe('"/a/\\$x\\"y"');
    expect(argumentoDoExec('100%')).toBe('100%%');
    expect(conteudoDoAutostart(['/home/a b/Tela.AppImage'])).toContain('Exec="/home/a b/Tela.AppImage" --oculto');
  });

  it('barra invertida literal vira quatro no arquivo (escape de string + de aspas)', () => {
    expect(argumentoDoExec('/a/b\\c')).toBe('"/a/b\\\\\\\\c"');
  });

  it('S-18: caractere de controle no caminho é recusado, não injeta chaves no .desktop', () => {
    expect(() => conteudoDoAutostart(['/home/u/x.AppImage\nHidden=true\nX-Evil=1'])).toThrow(RangeError);
    for (const c of ['\n', '\r', '\t', '\0', '\x7f', '\x1b']) {
      expect(() => argumentoDoExec(`/a${c}b`), JSON.stringify(c)).toThrow(RangeError);
    }
  });

  it('AppImage: o caminho estável é $APPIMAGE, não o ponto de montagem', () => {
    expect(executavelDoAutostart({ APPIMAGE: '/home/a/Tela.AppImage' }, '/tmp/.mount_x/tela')).toBe('/home/a/Tela.AppImage');
    expect(executavelDoAutostart({}, '/opt/Tela/tela')).toBe('/opt/Tela/tela');
  });
});
