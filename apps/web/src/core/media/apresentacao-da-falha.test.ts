import { describe, expect, it } from 'vitest';
import { APRESENTACAO_DA_FALHA } from './apresentacao-da-falha.js';

const todas = Object.entries(APRESENTACAO_DA_FALHA);

describe('APRESENTACAO_DA_FALHA', () => {
  it('cada motivo tem o título próprio, e "SEM SINAL" é do espectador', () => {
    const titulos = todas.map(([, a]) => a.titulo);
    expect(new Set(titulos).size).toBe(titulos.length);
    expect(titulos).not.toContain('SEM SINAL');
  });

  it('cancelar o seletor é escolha: tom de aviso, nunca falha', () => {
    expect(APRESENTACAO_DA_FALHA.CAPTURE_DENIED).toMatchObject({
      titulo: 'COMPARTILHAMENTO CANCELADO',
      tom: 'aviso',
      acao: 'tentar-de-novo',
    });
  });

  it('nome em uso leva ao passo 1, e insistir não é opção', () => {
    expect(APRESENTACAO_DA_FALHA.SLUG_TAKEN).toMatchObject({
      titulo: 'NOME EM USO',
      acao: 'escolher-nome',
      rotuloAcao: 'ESCOLHER OUTRO NOME',
    });
    expect(APRESENTACAO_DA_FALHA.SLUG_INVALID.acao).toBe('escolher-nome');
  });

  it('navegador sem captura não oferece tentar de novo', () => {
    expect(APRESENTACAO_DA_FALHA.CAPTURE_UNSUPPORTED.acao).toBe('nenhuma');
    expect(APRESENTACAO_DA_FALHA.CAPTURE_UNSUPPORTED.rotuloAcao).toBe('');
  });

  it('só as falhas técnicas oferecem o diagnóstico da tentativa', () => {
    const com = todas.filter(([, a]) => a.comDiagnostico).map(([motivo]) => motivo).sort();
    expect(com).toEqual(['CAPTURE_FAILED', 'SIGNALING_UNAVAILABLE', 'TRANSPORT_FAILED']);
  });

  it('o fim normal é o único tom normal', () => {
    expect(todas.filter(([, a]) => a.tom === 'normal').map(([m]) => m)).toEqual(['USER_STOPPED']);
  });

  it('todo botão tem rótulo quando há ação', () => {
    for (const [, a] of todas) {
      expect(a.acao === 'nenhuma' ? a.rotuloAcao === '' : a.rotuloAcao !== '').toBe(true);
    }
  });
});
