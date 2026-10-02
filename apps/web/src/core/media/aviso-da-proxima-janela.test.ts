import { describe, expect, it } from 'vitest';
import { avisoDaProximaJanela } from './aviso-da-proxima-janela.js';

describe('avisoDaProximaJanela', () => {
  it('Windows: manda marcar o áudio do sistema na caixa do navegador', () => {
    expect(avisoDaProximaJanela('display-media', false)).toMatch(/Compartilhar áudio do sistema/);
  });
  it('Linux: o som vem da entrada, não da janela', () => {
    expect(avisoDaProximaJanela('monitor-device', false)).toMatch(/entrada escolhida/);
  });
  it('macOS: avisa que o som do jogo não vai junto', () => {
    expect(avisoDaProximaJanela('unsupported', false)).toMatch(/não vai junto/);
  });
  it('no app não fala de caixa do navegador', () => {
    expect(avisoDaProximaJanela('display-media', true)).not.toMatch(/Compartilhar áudio/);
  });
});
