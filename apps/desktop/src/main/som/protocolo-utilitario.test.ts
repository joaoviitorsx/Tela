import { describe, expect, it } from 'vitest';
import { addonSabeExcluir, appsDasSessoes, pedidoValido, pidValido, respostaValida } from './protocolo-utilitario.js';

describe('pedidoValido (o que o utility aceita do main)', () => {
  it('aceita os cinco pedidos', () => {
    expect(pedidoValido({ t: 'sondar' })).toEqual({ t: 'sondar' });
    expect(pedidoValido({ t: 'listar' })).toEqual({ t: 'listar' });
    expect(pedidoValido({ t: 'parar' })).toEqual({ t: 'parar' });
    expect(pedidoValido({ t: 'capturar', pid: 1234, modo: 'incluir' })).toEqual({ t: 'capturar', pid: 1234, modo: 'incluir' });
    expect(pedidoValido({ t: 'capturar', pid: 1234, modo: 'excluir' })).toEqual({ t: 'capturar', pid: 1234, modo: 'excluir' });
    expect(pedidoValido({ t: 'trocar', pid: 1234, modo: 'excluir' })).toEqual({ t: 'trocar', pid: 1234, modo: 'excluir' });
  });

  it('capturar e trocar sem um modo conhecido são recusados: o modo decide se a call vai junto', () => {
    for (const modo of [undefined, '', 'tudo', 'EXCLUIR', 1, true]) {
      expect(pedidoValido({ t: 'capturar', pid: 1234, modo }), String(modo)).toBeNull();
      expect(pedidoValido({ t: 'trocar', pid: 1234, modo }), String(modo)).toBeNull();
    }
  });

  it('descarta campos a mais e pedidos mal formados', () => {
    expect(pedidoValido({ t: 'listar', extra: 1 })).toEqual({ t: 'listar' });
    for (const ruim of [null, 3, 'listar', {}, { t: 'x' }, { t: 'capturar' }, { t: 'capturar', pid: '12', modo: 'incluir' }, { t: 'capturar', pid: 4, modo: 'incluir' }, { t: 'capturar', pid: -1, modo: 'incluir' }, { t: 'trocar', pid: 1.5, modo: 'excluir' }]) {
      expect(pedidoValido(ruim)).toBeNull();
    }
  });
});

describe('addonSabeExcluir', () => {
  it('só a 1.1 em diante: uma 1.0 capturaria SÓ o alvo (a call)', () => {
    expect(['1.1.0', '1.2.3', '2.0.0', '1.10.0'].map(addonSabeExcluir)).toEqual([true, true, true, true]);
    expect(['1.0.0', '0.9.0', '', 'x', '1'].map(addonSabeExcluir)).toEqual([false, false, false, false, false]);
  });
});

describe('pidValido', () => {
  it('recusa o Idle, o System e o que não é inteiro de 32 bits', () => {
    expect([0, 4, -3, 1.2, 2 ** 31, Number.NaN, '7'].map(pidValido)).toEqual([false, false, false, false, false, false, false]);
    expect(pidValido(5)).toBe(true);
    expect(pidValido(0x7fffffff)).toBe(true);
  });
});

describe('respostaValida (o que o main aceita do utility)', () => {
  it('lê as respostas conhecidas', () => {
    expect(respostaValida({ t: 'sonda', ok: true, versao: '1.0.0' })).toEqual({ t: 'sonda', ok: true, versao: '1.0.0' });
    expect(respostaValida({ t: 'sonda', ok: false, erro: 'ADDON_AUSENTE' })).toEqual({ t: 'sonda', ok: false, erro: 'ADDON_AUSENTE' });
    expect(respostaValida({ t: 'capturando' })).toEqual({ t: 'capturando' });
    expect(respostaValida({ t: 'fim', motivo: 'PROCESSO_ENCERROU' })).toEqual({ t: 'fim', motivo: 'PROCESSO_ENCERROU' });
    expect(respostaValida({ t: 'erro', erro: 'ATIVACAO_RECUSADA' })).toEqual({ t: 'erro', erro: 'ATIVACAO_RECUSADA' });
    const s = { pid: 100, nome: 'Jogo', caminho: 'C:\\Jogos\\Jogo.exe', ativa: true };
    expect(respostaValida({ t: 'sessoes', sessoes: [s] })).toEqual({ t: 'sessoes', sessoes: [s] });
  });

  it('lixo vira null, não exceção', () => {
    const lixo: unknown[] = [
      undefined,
      'x',
      { t: 'sessoes', sessoes: 'x' },
      { t: 'sessoes', sessoes: [{ pid: 1 }] },
      { t: 'sessoes', sessoes: [{ pid: 100, nome: '', caminho: '', ativa: true }] },
      { t: 'sonda', ok: false, erro: 'QUALQUER' },
      { t: 'fim', motivo: 'x' },
      { t: 'erro', erro: 7 },
      { t: 'sonda', ok: true },
    ];
    for (const l of lixo) expect(respostaValida(l)).toBeNull();
  });

  it('não aceita mais de 256 sessões', () => {
    const s = { pid: 100, nome: 'x', caminho: '', ativa: false };
    expect(respostaValida({ t: 'sessoes', sessoes: Array.from({ length: 257 }, () => s) })).toBeNull();
  });
});

describe('appsDasSessoes', () => {
  const s = (pid: number, nome: string, ativa: boolean) => ({ pid, nome, caminho: `C:\\${nome}.exe`, ativa });

  it('um item por pid, quem toca primeiro, depois por nome', () => {
    const apps = appsDasSessoes([s(30, 'Zeta', false), s(10, 'Alfa', false), s(20, 'Beta', true), s(20, 'Beta', false)], new Set());
    expect(apps.map((a) => [a.id, a.tocando])).toEqual([['pid:20', true], ['pid:10', false], ['pid:30', false]]);
  });

  it('tira os processos do próprio Tela', () => {
    expect(appsDasSessoes([s(10, 'Tela', true), s(11, 'Jogo', true)], new Set([10])).map((a) => a.pid)).toEqual([11]);
  });
});
