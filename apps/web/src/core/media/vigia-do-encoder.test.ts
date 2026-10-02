import { describe, expect, it } from 'vitest';
import { CAPACIDADE, QUADROS_SEM_SAIDA, TRAVA_MS, VigiaDoEncoder } from './vigia-do-encoder.js';

describe('VigiaDoEncoder — tempo por quadro', () => {
  it('mede entrada→saída e zera a média a cada leitura', () => {
    const v = new VigiaDoEncoder();
    v.reiniciar(0);
    v.entrou(1, 0);
    v.entrou(2, 16);
    v.saiu(1, 4);
    v.saiu(2, 24);
    expect(v.lerMsPorQuadro()).toBe(6); // (4 + 8) / 2
    expect(v.lerMsPorQuadro()).toBeNull();
  });

  it('saída fora de ordem descarta os mais antigos: quadro pulado não envelhece no anel', () => {
    const v = new VigiaDoEncoder();
    v.reiniciar(0);
    v.entrou(1, 0);
    v.entrou(2, 10);
    v.entrou(3, 20);
    v.saiu(2, 30); // o 1 foi pulado pelo encoder
    expect(v.lerMsPorQuadro()).toBe(20);
    v.saiu(1, 40); // já não está pendente: não vira amostra
    expect(v.lerMsPorQuadro()).toBeNull();
    v.saiu(3, 41);
    expect(v.lerMsPorQuadro()).toBe(21);
  });

  it('anel cheio: o mais antigo perde a vaga, sem crescer', () => {
    const v = new VigiaDoEncoder();
    v.reiniciar(0);
    for (let i = 0; i < CAPACIDADE + 4; i++) v.entrou(i, i);
    v.saiu(0, 100); // expulso do anel
    expect(v.lerMsPorQuadro()).toBeNull();
    v.saiu(CAPACIDADE + 3, 100);
    expect(v.lerMsPorQuadro()).toBe(100 - (CAPACIDADE + 3));
  });

  it('carimbo desconhecido não vira amostra nem quebra o anel', () => {
    const v = new VigiaDoEncoder();
    v.reiniciar(0);
    v.entrou(5, 0);
    v.saiu(99, 10);
    expect(v.lerMsPorQuadro()).toBeNull();
    v.saiu(5, 12);
    expect(v.lerMsPorQuadro()).toBe(12);
  });
});

describe('VigiaDoEncoder — trava', () => {
  it('quadros oferecidos e nenhuma saída por TRAVA_MS: travou', () => {
    const v = new VigiaDoEncoder();
    v.reiniciar(0);
    let t = 0;
    for (let i = 0; i < 3; i++) v.entrou(i, (t += 16));
    while (t < TRAVA_MS) {
      v.recusado(); // fila cheia: descartado na entrada
      t += 16;
    }
    expect(v.travou(t)).toBe(true);
  });

  it('tela parada não é trava: sem quadro oferecido, o tempo sozinho não acusa', () => {
    const v = new VigiaDoEncoder();
    v.reiniciar(0);
    v.entrou(1, 0);
    // 10 s sem quadro novo (captura zero-hertz), e então um quadro chega.
    v.entrou(2, 10_000);
    expect(v.travou(10_000)).toBe(false);
  });

  it('primeiro IDR lento do hardware não é trava: a contagem sozinha não acusa', () => {
    const v = new VigiaDoEncoder();
    v.reiniciar(0);
    for (let i = 0; i < QUADROS_SEM_SAIDA + 10; i++) v.entrou(i, i * 16);
    expect(v.travou((QUADROS_SEM_SAIDA + 10) * 16)).toBe(false); // ~640 ms
  });

  it('uma saída zera a trava; reiniciar também', () => {
    const v = new VigiaDoEncoder();
    v.reiniciar(0);
    for (let i = 0; i < QUADROS_SEM_SAIDA; i++) v.recusado();
    expect(v.travou(TRAVA_MS)).toBe(true);
    v.saiu(0, TRAVA_MS);
    expect(v.travou(TRAVA_MS + 1)).toBe(false);
    for (let i = 0; i < QUADROS_SEM_SAIDA; i++) v.recusado();
    v.reiniciar(3 * TRAVA_MS);
    expect(v.travou(3 * TRAVA_MS + 10)).toBe(false);
  });
});
