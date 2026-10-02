import { describe, expect, it } from 'vitest';
import { alvoDaExclusao, ehAppDeVozNoLinux, ehAppDeVozNoWindows } from './apps-de-voz.js';

const sessao = (pid: number, nome: string, ativa = true) => ({ pid, nome, caminho: `C:\\Apps\\${nome}.exe`, ativa });

describe('ehAppDeVozNoWindows', () => {
  it('reconhece o Discord nas três edições, sem caixa', () => {
    for (const n of ['Discord', 'DiscordPTB', 'DiscordCanary', 'discord', 'DISCORD']) expect(ehAppDeVozNoWindows(n), n).toBe(true);
  });

  it('reconhece os outros apps de voz da lista', () => {
    for (const n of ['ts3client_win64', 'TeamSpeak', 'ms-teams', 'Teams', 'Zoom', 'Skype', 'mumble']) expect(ehAppDeVozNoWindows(n), n).toBe(true);
  });

  it('jogo, navegador e música não são a call', () => {
    for (const n of ['Minecraft', 'chrome', 'Spotify', 'DiscordiaGame', 'Tela', '']) expect(ehAppDeVozNoWindows(n), n).toBe(false);
  });
});

describe('ehAppDeVozNoLinux', () => {
  it('o motor de voz do Discord nativo, pelo nome ou pelo binário', () => {
    expect(ehAppDeVozNoLinux('WEBRTC VoiceEngine', 'Discord')).toBe(true);
    expect(ehAppDeVozNoLinux('Chromium', 'Discord')).toBe(true);
    expect(ehAppDeVozNoLinux('Discord', null)).toBe(true);
    expect(ehAppDeVozNoLinux(null, 'vesktop')).toBe(true);
  });

  it('TeamSpeak, Mumble, Zoom, Skype e Teams', () => {
    for (const [nome, bin] of [
      ['TeamSpeak 3', 'ts3client_linux_amd64'],
      ['Mumble', 'mumble'],
      ['ZOOM VoiceEngine', 'zoom'],
      ['Skype', 'skypeforlinux'],
      ['teams-for-linux', null],
    ] as const) {
      expect(ehAppDeVozNoLinux(nome, bin), nome).toBe(true);
    }
  });

  it('o resto vai junto: jogo, navegador, player, e quem não diz nada', () => {
    expect(ehAppDeVozNoLinux('Jogo-Exemplo', 'jogo-exemplo')).toBe(false);
    expect(ehAppDeVozNoLinux('Firefox', 'firefox')).toBe(false);
    expect(ehAppDeVozNoLinux('Chamada-Voz', 'chamada')).toBe(false);
    expect(ehAppDeVozNoLinux(null, null)).toBe(false);
  });
});

describe('alvoDaExclusao', () => {
  const TELA = new Set([999, 1000]);

  it('o Discord vence qualquer outro app de voz, mesmo calado', () => {
    const r = alvoDaExclusao([sessao(10, 'Zoom'), sessao(20, 'Jogo'), sessao(30, 'Discord', false)], TELA, 999);
    expect(r).toEqual({ pid: 30, app: 'Discord' });
  });

  it('entre dois Discords, o que está tocando', () => {
    expect(alvoDaExclusao([sessao(30, 'Discord', false), sessao(31, 'DiscordPTB', true)], TELA, 999).pid).toBe(31);
  });

  it('sem Discord, o primeiro app de voz (tocando antes de calado)', () => {
    expect(alvoDaExclusao([sessao(10, 'Jogo'), sessao(11, 'mumble', false), sessao(12, 'Teams')], TELA, 999)).toEqual({ pid: 12, app: 'Teams' });
    expect(alvoDaExclusao([sessao(11, 'mumble'), sessao(12, 'Teams')], TELA, 999).pid).toBe(11);
  });

  it('sem app de voz, exclui o próprio Tela', () => {
    expect(alvoDaExclusao([sessao(10, 'Jogo'), sessao(20, 'Spotify')], TELA, 999)).toEqual({ pid: 999, app: null });
    expect(alvoDaExclusao([], TELA, 999)).toEqual({ pid: 999, app: null });
  });

  it('uma sessão do próprio Tela nunca é o alvo, nem com nome de app de voz', () => {
    expect(alvoDaExclusao([sessao(1000, 'Discord')], TELA, 999)).toEqual({ pid: 999, app: null });
  });
});

describe('alvoDaExclusao — Discord achado pelas raízes de processo (addon 1.2.0)', () => {
  const TELA = new Set([999, 1000]);
  const proc = (pid: number, nome: string) => ({ pid, nome });

  it('Discord tocando no headset (fora da saída padrão): achado pelo processo, não pela sessão', () => {
    // A listagem de sessões só viu o jogo; o Discord está entre os processos.
    expect(alvoDaExclusao([sessao(10, 'Jogo')], TELA, 999, [proc(10, 'Jogo'), proc(50, 'Discord'), proc(60, 'explorer')])).toEqual({
      pid: 50,
      app: 'Discord',
    });
  });

  it('sessão e processo do mesmo Discord: um alvo só, e quem toca ganha', () => {
    expect(alvoDaExclusao([sessao(50, 'Discord', true)], TELA, 999, [proc(50, 'Discord'), proc(70, 'Teams')]).pid).toBe(50);
  });

  it('Discord sem som ainda ganha de outro app de voz tocando', () => {
    expect(alvoDaExclusao([sessao(70, 'Teams', true)], TELA, 999, [proc(50, 'Discord')]).pid).toBe(50);
  });

  it('nenhum app de voz entre processos e sessões: o próprio Tela, e app null', () => {
    expect(alvoDaExclusao([sessao(10, 'Jogo')], TELA, 999, [proc(10, 'Jogo'), proc(20, 'Spotify')])).toEqual({ pid: 999, app: null });
  });
});
