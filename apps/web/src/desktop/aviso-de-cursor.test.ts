import { describe, expect, it } from 'vitest';
import { avisoDeCursor } from './aviso-de-cursor.js';

describe('avisoDeCursor', () => {
  it('a janela do LoL no Windows avisa (cliente e partida)', () => {
    expect(avisoDeCursor({ nome: 'League of Legends (TM) Client', tipo: 'janela' }, 'win32')).toMatch(/cursor/);
    expect(avisoDeCursor({ nome: 'League of Legends', tipo: 'janela' }, 'win32')).toMatch(/Sem bordas/);
  });

  it('a TELA, outros jogos e outros sistemas não avisam', () => {
    expect(avisoDeCursor({ nome: 'League of Legends', tipo: 'tela' }, 'win32')).toBeNull();
    expect(avisoDeCursor({ nome: 'Hades II', tipo: 'janela' }, 'win32')).toBeNull();
    expect(avisoDeCursor({ nome: 'League of Legends (TM) Client', tipo: 'janela' }, 'linux')).toBeNull();
  });
});
