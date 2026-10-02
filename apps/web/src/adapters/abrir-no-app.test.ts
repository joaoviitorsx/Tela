// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRAZO_DA_TENTATIVA_MS } from '../core/domain/abrir-no-app.js';
import { makeAbrirNoApp } from './abrir-no-app.js';

beforeEach(() => {
  vi.useFakeTimers();
  // O happy-dom não carrega iframe de esquema desconhecido e reclama no stderr;
  // o que o teste confere é o `src`, o foco e o prazo, não o carregamento.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('makeAbrirNoApp.tentar', () => {
  it('lança tela://assistir/<canal> num iframe escondido', () => {
    void makeAbrirNoApp().tentar('joao');
    const quadro = document.querySelector('iframe');
    expect(quadro?.getAttribute('src')).toBe('tela://assistir/joao');
    expect(quadro?.hidden).toBe(true);
  });

  it('"abriu" assim que a página perde o foco, sem esperar o prazo', async () => {
    const tentativa = makeAbrirNoApp().tentar('joao');
    await vi.advanceTimersByTimeAsync(300);
    window.dispatchEvent(new Event('blur'));
    await expect(tentativa).resolves.toBe('abriu');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('"abriu" quando a aba fica escondida (a janela do app cobriu o navegador)', async () => {
    const tentativa = makeAbrirNoApp().tentar('joao');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await expect(tentativa).resolves.toBe('abriu');
  });

  it('"nao-abriu" quando o prazo vence sem sinal, e limpa tudo', async () => {
    const tentativa = makeAbrirNoApp().tentar('joao');
    await vi.advanceTimersByTimeAsync(PRAZO_DA_TENTATIVA_MS - 1);
    expect(document.querySelector('iframe')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await expect(tentativa).resolves.toBe('nao-abriu');
    expect(document.querySelector('iframe')).toBeNull();
    // um blur tardio não muda nada nem lança
    window.dispatchEvent(new Event('blur'));
  });

  it('o prazo é de 1,5 s', () => {
    expect(PRAZO_DA_TENTATIVA_MS).toBe(1_500);
  });
});

describe('makeAbrirNoApp.ambiente', () => {
  it('lê o que a decisão precisa', () => {
    const amb = makeAbrirNoApp().ambiente();
    expect(typeof amb.userAgent).toBe('string');
    expect(amb.dentroDoApp).toBe(false);
    expect(typeof amb.paginaEmFoco).toBe('boolean');
  });
});
