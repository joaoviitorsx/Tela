import { describe, expect, it } from 'vitest';
import { AVISO_DE_CURSOR, avisoDeCursor } from './aviso-de-cursor.js';

const tela = { nome: 'TELA INTEIRA', tipo: 'tela' as const };

describe('avisoDeCursor', () => {
  it('LoL aberto no Windows avisa, qualquer que seja a fonte que a pessoa vá escolher (cliente ou partida)', () => {
    expect(avisoDeCursor([tela, { nome: 'League of Legends (TM) Client', tipo: 'janela' }], 'win32')).toBe(AVISO_DE_CURSOR);
    expect(avisoDeCursor([tela, { nome: 'League of Legends', tipo: 'janela' }], 'win32')).toBe(AVISO_DE_CURSOR);
  });

  it('as duas saídas: a aba TELAS (o que funcionou no navegador) e o "Sem bordas"', () => {
    expect(AVISO_DE_CURSOR).toMatch(/aba TELAS/);
    expect(AVISO_DE_CURSOR).toMatch(/Sem bordas/);
  });

  it('aba de navegador, outros jogos e outros sistemas não avisam', () => {
    expect(avisoDeCursor([{ nome: 'League of Legends – Wiki - Google Chrome', tipo: 'janela' }], 'win32')).toBeNull();
    expect(avisoDeCursor([{ nome: 'Hades II', tipo: 'janela' }], 'win32')).toBeNull();
    expect(avisoDeCursor([{ nome: 'League of Legends (TM) Client', tipo: 'janela' }], 'linux')).toBeNull();
    expect(avisoDeCursor([], 'win32')).toBeNull();
  });
});
