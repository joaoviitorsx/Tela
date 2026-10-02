// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { __TELA_VERSION__: null });
});

import { painelDiagnostico } from '../react/painel-diagnostico.js';
import { DiagnosticoDoApp } from './DiagnosticoDoApp.js';
import { criarSessaoAoVivo } from './sessao-ao-vivo.js';
import { estadoVivo, sessaoFalsa } from './testes-de-sessao.js';

afterEach(() => {
  cleanup();
  painelDiagnostico.fechar();
});

const titulo = () => document.body.textContent?.includes('DIAGNÓSTICO ▸ REDE E CONEXÕES') ?? false;
const aberto = () => document.querySelector('dialog')?.hasAttribute('open') ?? false;

describe('DiagnosticoDoApp', () => {
  it('o DIAG do trilho abre o painel de rede quando não há transmissão', () => {
    render(<DiagnosticoDoApp sessao={criarSessaoAoVivo()} />);
    expect(titulo()).toBe(true);
    expect(aberto()).toBe(false);
    act(() => painelDiagnostico.abrir());
    expect(aberto()).toBe(true);
    act(() => painelDiagnostico.fechar());
    expect(aberto()).toBe(false);
  });

  it('ao vivo o painel é da rota de transmissão: este não abre em dobro', () => {
    const fonte = criarSessaoAoVivo();
    fonte.registrar(sessaoFalsa(estadoVivo({})).sessao);
    render(<DiagnosticoDoApp sessao={fonte} />);
    act(() => painelDiagnostico.abrir());
    expect(aberto()).toBe(false);
  });
});
