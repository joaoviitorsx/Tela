import { describe, expect, it } from 'vitest';
import { listaDeOrigens, origemPermitida } from './origem.js';

describe('origem do upgrade (TELA-019)', () => {
  it('a própria origem sempre passa, com ou sem lista', () => {
    expect(origemPermitida('https://tela.gg', [], 'https://tela.gg')).toBe(true);
    expect(origemPermitida('https://TELA.gg/', ['https://outra.dev'], 'https://tela.gg')).toBe(true);
  });

  it('origem de terceiros é barrada quando há regra', () => {
    expect(origemPermitida('https://mal.example', [], 'https://tela.gg')).toBe(false);
    expect(origemPermitida('https://mal.example', ['https://tela.gg'])).toBe(false);
  });

  it('lista explícita libera outra origem', () => {
    expect(origemPermitida('http://localhost:5173', ['http://localhost:5173'], 'https://tela.gg')).toBe(true);
  });

  it('o app desktop (app://tela) passa quando listado, e só assim (PLANO-desktop §3.5)', () => {
    expect(origemPermitida('app://tela', ['app://tela'], 'https://tela.gg')).toBe(true);
    expect(origemPermitida('APP://tela/', ['app://tela'], 'https://tela.gg')).toBe(true);
    expect(origemPermitida('app://tela', [], 'https://tela.gg')).toBe(false);
    expect(origemPermitida('app://outro', ['app://tela'], 'https://tela.gg')).toBe(false);
  });

  it('sem Origin passa: não é navegador, e a regra não é autenticação', () => {
    expect(origemPermitida(null, ['https://tela.gg'])).toBe(true);
    expect(origemPermitida('', ['https://tela.gg'])).toBe(true);
  });

  it('sem regra nenhuma (desenvolvimento) passa tudo', () => {
    expect(origemPermitida('https://qualquer.coisa', [])).toBe(true);
  });

  it('lista a partir da variável de ambiente', () => {
    expect(listaDeOrigens(' https://a.gg , ,https://b.gg ')).toEqual(['https://a.gg', 'https://b.gg']);
    expect(listaDeOrigens(undefined)).toEqual([]);
  });
});
