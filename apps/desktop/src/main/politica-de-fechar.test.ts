import { describe, expect, it } from 'vitest';
import {
  decidirFechar,
  type EntradaDeFechar,
  escolhaParaLembrar,
  JANELA_DE_QUEDAS_MS,
  modoValido,
  motivoDeQueda,
  registrarQueda,
  respostaDeFecharValida,
  urlDaRecuperacao,
} from './politica-de-fechar.js';

const base: EntradaDeFechar = {
  noAr: true,
  aoFecharAoVivo: 'perguntar',
  fecharEmSegundoPlano: false,
  temBandeja: true,
  modoCompacto: false,
};
const com = (p: Partial<EntradaDeFechar>): EntradaDeFechar => ({ ...base, ...p });

describe('decidirFechar', () => {
  it('fora do ar sai, a menos que "fechar = segundo plano" esteja ligado E haja bandeja', () => {
    expect(decidirFechar(com({ noAr: false }))).toBe('sair');
    expect(decidirFechar(com({ noAr: false, fecharEmSegundoPlano: true }))).toBe('esconder');
    expect(decidirFechar(com({ noAr: false, fecharEmSegundoPlano: true, temBandeja: false }))).toBe('sair');
  });
  it('ao vivo pergunta na primeira vez', () => {
    expect(decidirFechar(base)).toBe('perguntar');
    expect(decidirFechar(com({ temBandeja: false }))).toBe('perguntar');
  });
  it('lembrou "segundo plano": esconde com bandeja, compacto sem ela', () => {
    expect(decidirFechar(com({ aoFecharAoVivo: 'segundo-plano' }))).toBe('esconder');
    expect(decidirFechar(com({ aoFecharAoVivo: 'segundo-plano', temBandeja: false }))).toBe('compacto');
  });
  it('lembrou "encerrar": encerra e sai', () => {
    expect(decidirFechar(com({ aoFecharAoVivo: 'encerrar' }))).toBe('encerrar-e-sair');
  });
  it('já no compacto: esconde com bandeja, minimiza sem — nunca some sem controle', () => {
    expect(decidirFechar(com({ modoCompacto: true }))).toBe('esconder');
    expect(decidirFechar(com({ modoCompacto: true, temBandeja: false }))).toBe('minimizar');
    expect(decidirFechar(com({ modoCompacto: true, aoFecharAoVivo: 'encerrar', temBandeja: false }))).toBe('minimizar');
  });
});

describe('resposta do diálogo', () => {
  it('valida a forma', () => {
    expect(respostaDeFecharValida({ acao: 'segundo-plano', lembrar: true })).toEqual({ acao: 'segundo-plano', lembrar: true });
    for (const ruim of [null, 'x', {}, { acao: 'sim', lembrar: true }, { acao: 'encerrar' }, { acao: 'encerrar', lembrar: 1 }]) {
      expect(respostaDeFecharValida(ruim)).toBeNull();
    }
  });
  it('cancelar nunca é lembrado', () => {
    expect(respostaDeFecharValida({ acao: 'cancelar', lembrar: true })).toEqual({ acao: 'cancelar', lembrar: false });
  });
  it('só se lembra o que a pessoa marcou', () => {
    expect(escolhaParaLembrar({ acao: 'segundo-plano', lembrar: true })).toBe('segundo-plano');
    expect(escolhaParaLembrar({ acao: 'encerrar', lembrar: true })).toBe('encerrar');
    expect(escolhaParaLembrar({ acao: 'encerrar', lembrar: false })).toBeNull();
    expect(escolhaParaLembrar({ acao: 'cancelar', lembrar: false })).toBeNull();
  });
});

describe('modo e queda', () => {
  it('modo válido', () => {
    expect(modoValido('compacto')).toBe('compacto');
    expect(modoValido('normal')).toBe('normal');
    expect(modoValido('grande')).toBeNull();
    expect(modoValido(1)).toBeNull();
  });
  it('só motivos conhecidos de queda', () => {
    expect(motivoDeQueda('oom')).toBe('oom');
    expect(motivoDeQueda('clean-exit')).toBeNull();
    expect(motivoDeQueda('<script>')).toBeNull();
  });
  it('três quedas em 30 s param de recarregar; quedas antigas não contam', () => {
    let q: readonly number[] = [];
    const r1 = registrarQueda(q, 1000);
    q = r1.quedas;
    expect(r1.recarregar).toBe(true);
    const r2 = registrarQueda(q, 2000);
    q = r2.quedas;
    expect(r2.recarregar).toBe(true);
    expect(registrarQueda(q, 3000).recarregar).toBe(false);
    expect(registrarQueda(q, 2000 + JANELA_DE_QUEDAS_MS + 1).recarregar).toBe(true);
  });
  it('a URL de recuperação só carrega o motivo quando estava no ar', () => {
    expect(urlDaRecuperacao('app://tela/desktop.html', 'oom', false)).toBe('app://tela/desktop.html');
    expect(urlDaRecuperacao('app://tela/desktop.html', 'oom', true)).toBe('app://tela/desktop.html?queda=oom');
    expect(urlDaRecuperacao('app://tela/desktop.html', null, true)).toBe('app://tela/desktop.html?queda=crashed');
  });
});
