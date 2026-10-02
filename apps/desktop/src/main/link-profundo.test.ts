import { describe, expect, it } from 'vitest';
import {
  argumentosDoRegistro,
  canalDoArgv,
  canalDoLinkProfundo,
  deveRegistrarEsquema,
} from './link-profundo.js';

describe('canalDoLinkProfundo', () => {
  it('aceita só tela://assistir/<slug>', () => {
    expect(canalDoLinkProfundo('tela://assistir/joao')).toBe('joao');
    expect(canalDoLinkProfundo('tela://assistir/a1-b2')).toBe('a1-b2');
  });
  it('esquema e "host" sem caixa; o slug vai para minúsculas', () => {
    expect(canalDoLinkProfundo('TELA://Assistir/Joao')).toBe('joao');
  });
  it('barra final, consulta e fragmento são ignorados', () => {
    expect(canalDoLinkProfundo('tela://assistir/joao/')).toBe('joao');
    expect(canalDoLinkProfundo('tela://assistir/joao?transmitir=1')).toBe('joao');
    expect(canalDoLinkProfundo('tela://assistir/joao#x')).toBe('joao');
    expect(canalDoLinkProfundo('tela://assistir/joao/?a=b#c')).toBe('joao');
  });
  it('recusa outro "host", outro caminho e segmentos a mais', () => {
    expect(canalDoLinkProfundo('tela://transmitir/joao')).toBeNull();
    expect(canalDoLinkProfundo('tela://assistir')).toBeNull();
    expect(canalDoLinkProfundo('tela://assistir/')).toBeNull();
    expect(canalDoLinkProfundo('tela://assistir/joao/extra')).toBeNull();
    expect(canalDoLinkProfundo('tela:assistir/joao')).toBeNull();
    expect(canalDoLinkProfundo('tela:///assistir/joao')).toBeNull();
    expect(canalDoLinkProfundo('tela://user@assistir/joao')).toBeNull();
    expect(canalDoLinkProfundo('tela://assistir:80/joao')).toBeNull();
  });
  it('recusa slug fora da regra do roteador', () => {
    expect(canalDoLinkProfundo('tela://assistir/jv')).toBeNull(); // 2 letras
    expect(canalDoLinkProfundo('tela://assistir/-joao')).toBeNull();
    expect(canalDoLinkProfundo('tela://assistir/joao-')).toBeNull();
    expect(canalDoLinkProfundo('tela://assistir/jo_ao')).toBeNull();
    expect(canalDoLinkProfundo('tela://assistir/jo%61o')).toBeNull();
    expect(canalDoLinkProfundo(`tela://assistir/${'a'.repeat(26)}`)).toBeNull();
    expect(canalDoLinkProfundo(`tela://assistir/${'a'.repeat(25)}`)).toBe('a'.repeat(25));
    expect(canalDoLinkProfundo('tela://assistir/../etc')).toBeNull();
  });
  it('rotas do site não são canais', () => {
    expect(canalDoLinkProfundo('tela://assistir/transmitir')).toBeNull();
    expect(canalDoLinkProfundo('tela://assistir/recuperar')).toBeNull();
  });
  it('recusa espaço, controle, lixo e tipos errados', () => {
    expect(canalDoLinkProfundo('tela://assistir/joao --gpu-launcher=x')).toBeNull();
    expect(canalDoLinkProfundo('tela://assistir/joao\n')).toBeNull();
    expect(canalDoLinkProfundo('https://tela.gg/joao')).toBeNull();
    expect(canalDoLinkProfundo('javascript:alert(1)')).toBeNull();
    expect(canalDoLinkProfundo('')).toBeNull();
    expect(canalDoLinkProfundo(null)).toBeNull();
    expect(canalDoLinkProfundo(42)).toBeNull();
    expect(canalDoLinkProfundo(`tela://assistir/joao?${'a'.repeat(300)}`)).toBeNull();
  });
});

describe('canalDoArgv', () => {
  it('Linux: o link é um argumento solto', () => {
    expect(canalDoArgv(['/opt/Tela/tela', 'tela://assistir/joao'])).toBe('joao');
    expect(canalDoArgv(['/opt/Tela/tela', '--no-sandbox', 'tela://assistir/joao'])).toBe('joao');
  });
  it('Windows: depois do `--` e entre aspas', () => {
    expect(canalDoArgv(['C:\\Users\\x\\Tela\\Tela.exe', '--', '"tela://assistir/joao"'])).toBe('joao');
    expect(canalDoArgv(['C:\\Tela.exe', '"tela://assistir/joao/"'])).toBe('joao');
    expect(canalDoArgv(["C:\\Tela.exe", "'tela://assistir/joao'"])).toBe('joao');
  });
  it('dev: o caminho do app vem antes', () => {
    expect(canalDoArgv(['electron', '/repo/apps/desktop', 'tela://assistir/joao'])).toBe('joao');
  });
  it('sem link, ou só flags, é null', () => {
    expect(canalDoArgv([])).toBeNull();
    expect(canalDoArgv(['tela', '--', '--flag'])).toBeNull();
    expect(canalDoArgv(['C:\\Program Files\\Tela\\Tela.exe'])).toBeNull();
  });
  it('um link suspeito não deixa um "bonzinho" depois dele passar', () => {
    expect(canalDoArgv(['tela', 'tela://assistir/..', 'tela://assistir/joao'])).toBeNull();
  });
  it('outros esquemas no argv não são o link', () => {
    expect(canalDoArgv(['tela', 'https://tela.gg/joao'])).toBeNull();
  });
});

describe('deveRegistrarEsquema', () => {
  it('só o empacotado registra, salvo decisão explícita', () => {
    expect(deveRegistrarEsquema(true, {})).toBe(true);
    expect(deveRegistrarEsquema(false, {})).toBe(false);
    expect(deveRegistrarEsquema(false, { TELA_REGISTRAR_ESQUEMA: '1' })).toBe(true);
    expect(deveRegistrarEsquema(true, { TELA_REGISTRAR_ESQUEMA: '0' })).toBe(false);
  });
});

describe('argumentosDoRegistro', () => {
  const resolver = (c: string) => `/abs/${c}`;
  it('em dev leva o caminho do app; empacotado, nada', () => {
    expect(argumentosDoRegistro(true, ['electron', '.'], resolver)).toEqual(['/abs/.']);
    expect(argumentosDoRegistro(false, ['tela'], resolver)).toBeNull();
    expect(argumentosDoRegistro(true, ['electron'], resolver)).toBeNull();
  });
});
