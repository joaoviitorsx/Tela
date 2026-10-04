import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DONO,
  ehMaisNova,
  mensagemDeErro,
  modoDeAtualizacao,
  PREFIXO_DA_TAG,
  releaseMaisNova,
  releaseMaisNovaDoTexto,
  REPOSITORIO,
  TAMANHO_MAXIMO_DA_LISTA,
  urlDaPaginaDoRelease,
  urlDoFeed,
  URL_DA_LISTA_DE_RELEASES,
} from './atualizacao-release.js';

const pub = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: true, ...extra });

describe('ehMaisNova (semver 2.0)', () => {
  it('beta.10 > beta.9 (numérico, não lexical) e beta.7 > beta.6', () => {
    expect(ehMaisNova('0.1.0-beta.10', '0.1.0-beta.9')).toBe(true);
    expect(ehMaisNova('0.1.0-beta.7', '0.1.0-beta.6')).toBe(true);
    expect(ehMaisNova('0.1.0-beta.6', '0.1.0-beta.6')).toBe(false);
    expect(ehMaisNova('0.1.0-beta.5', '0.1.0-beta.6')).toBe(false);
  });
  it('a final vence a beta; núcleo maior vence tudo; rc > beta', () => {
    expect(ehMaisNova('0.1.0', '0.1.0-beta.9')).toBe(true);
    expect(ehMaisNova('0.1.0-beta.9', '0.1.0')).toBe(false);
    expect(ehMaisNova('0.2.0-beta.1', '0.1.9')).toBe(true);
    expect(ehMaisNova('0.1.0-rc.1', '0.1.0-beta.9')).toBe(true);
    expect(ehMaisNova('0.1.0-beta.2', '0.1.0-beta')).toBe(true);
  });
  it('o que não é semver nunca é "mais novo"', () => {
    expect(ehMaisNova('latest', '0.1.0')).toBe(false);
    expect(ehMaisNova('0.1.0', 'x')).toBe(false);
  });
});

describe('releaseMaisNova (a lista da API é dado da rede)', () => {
  it('escolhe a maior tag desktop-v publicada, pré-release incluso, ignorando rascunho e tags de outro app', () => {
    const lista = [
      pub('desktop-v0.1.0-beta.6'),
      pub('desktop-v0.1.0-beta.10'),
      pub('desktop-v0.1.0-beta.9'),
      pub('desktop-v0.1.0-beta.11', { draft: true }),
      pub('v9.9.9'),
      pub('desktop-vlatest'),
      pub('desktop-v0.1.0-beta.7/../../x'),
    ];
    expect(releaseMaisNova(lista)).toEqual({ tag: 'desktop-v0.1.0-beta.10', versao: '0.1.0-beta.10' });
  });
  it('lixo em vez de lista, itens malformados e lista sem tag do app = null', () => {
    expect(releaseMaisNova(null)).toBeNull();
    expect(releaseMaisNova({ tag_name: 'desktop-v1.0.0' })).toBeNull();
    expect(releaseMaisNova([1, null, 'x', { tag_name: 5, draft: false }, { tag_name: 'desktop-v1.0.0' }])).toBeNull();
    expect(releaseMaisNova([pub('v1.0.0')])).toBeNull();
  });
  it('do texto: JSON quebrado ou grande demais = null', () => {
    expect(releaseMaisNovaDoTexto('{quebrado')).toBeNull();
    expect(releaseMaisNovaDoTexto(' '.repeat(TAMANHO_MAXIMO_DA_LISTA + 1))).toBeNull();
    expect(releaseMaisNovaDoTexto(JSON.stringify([pub('desktop-v0.1.0-beta.7')]))?.versao).toBe('0.1.0-beta.7');
  });
});

describe('URLs', () => {
  const r = { tag: 'desktop-v0.1.0-beta.7', versao: '0.1.0-beta.7' };
  it('o feed é a pasta de downloads da tag, em HTTPS no github.com', () => {
    expect(urlDoFeed(r)).toBe('https://github.com/joaoviitorsx/Tela/releases/download/desktop-v0.1.0-beta.7/');
    expect(urlDaPaginaDoRelease(r)).toBe('https://github.com/joaoviitorsx/Tela/releases/tag/desktop-v0.1.0-beta.7');
    expect(URL_DA_LISTA_DE_RELEASES.startsWith('https://api.github.com/repos/joaoviitorsx/Tela/releases')).toBe(true);
  });
  it('dono, repositório e prefixo são os do electron-builder.yml (publish)', () => {
    const yml = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
    expect(yml).toMatch(new RegExp(`^\\s+owner: ${DONO}$`, 'm'));
    expect(yml).toMatch(new RegExp(`^\\s+repo: ${REPOSITORIO}$`, 'm'));
    expect(yml).toMatch(new RegExp(`^\\s+tagNamePrefix: ${PREFIXO_DA_TAG}$`, 'm'));
  });
});

describe('modoDeAtualizacao (detecção de plataforma e empacotamento)', () => {
  const env = (e: Record<string, string> = {}) => e;
  it('Windows empacotado: automática', () => {
    expect(modoDeAtualizacao({ plataforma: 'win32', empacotado: true, env: env() })).toBe('automatica');
  });
  it('Linux com APPIMAGE: automática; sem (deb/rpm): só avisa', () => {
    expect(modoDeAtualizacao({ plataforma: 'linux', empacotado: true, env: env({ APPIMAGE: '/h/Tela.AppImage', APPDIR: '/tmp/.mount_Tela' }) })).toBe('automatica');
    // U-2: APPIMAGE sozinho (vazado no ambiente de um deb/rpm) não liga auto-update.
    expect(modoDeAtualizacao({ plataforma: 'linux', empacotado: true, env: env({ APPIMAGE: '/h/Tela.AppImage' }) })).toBe('avisar');
    expect(modoDeAtualizacao({ plataforma: 'linux', empacotado: true, env: env() })).toBe('avisar');
    expect(modoDeAtualizacao({ plataforma: 'linux', empacotado: true, env: env({ APPIMAGE: '' }) })).toBe('avisar');
  });
  it('fora do pacote, em macOS e com TELA_ATUALIZACAO=0: desligada', () => {
    expect(modoDeAtualizacao({ plataforma: 'win32', empacotado: false, env: env() })).toBe('desligada');
    expect(modoDeAtualizacao({ plataforma: 'linux', empacotado: false, env: env({ APPIMAGE: '/x' }) })).toBe('desligada');
    expect(modoDeAtualizacao({ plataforma: 'darwin', empacotado: true, env: env() })).toBe('desligada');
    expect(modoDeAtualizacao({ plataforma: 'win32', empacotado: true, env: env({ TELA_ATUALIZACAO: '0' }) })).toBe('desligada');
  });
});

describe('mensagemDeErro', () => {
  it('uma linha, sem pilha, com teto', () => {
    expect(mensagemDeErro(new Error('falhou\n    at foo (/home/x/y.js:1:1)'))).toBe('falhou');
    expect(mensagemDeErro('simples')).toBe('simples');
    expect(mensagemDeErro(new Error(''))).toBe('erro desconhecido');
    expect(mensagemDeErro(new Error('x'.repeat(500))).length).toBe(160);
  });
});
