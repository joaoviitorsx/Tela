// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModoCompacto } from './ModoCompacto.js';

afterEach(cleanup);

function montar(sobre: Partial<Parameters<typeof ModoCompacto>[0]> = {}) {
  const aoes = {
    aoCopiar: vi.fn(),
    aoEncerrar: vi.fn(),
    aoConfirmar: vi.fn(),
    aoCancelar: vi.fn(),
    aoExpandir: vi.fn(),
  };
  render(
    <ModoCompacto
      link="tela.gg/jv"
      tempo="01:05"
      assistindo={2}
      capacidade={50}
      copiado={false}
      confirmando={false}
      textoConfirmar="2 amigos estão assistindo agora e vão perder a imagem."
      {...aoes}
      {...sobre}
    />,
  );
  return aoes;
}

describe('ModoCompacto', () => {
  it('mostra link, tempo e n/N, e as duas saídas', () => {
    const a = montar();
    expect(screen.getByText('tela.gg/jv')).toBeTruthy();
    expect(screen.getByText('01:05')).toBeTruthy();
    expect(screen.getByText(/2\/50 assistindo/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'EXPANDIR' }));
    fireEvent.click(screen.getByRole('button', { name: 'ENCERRAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'COPIAR' }));
    expect(a.aoExpandir).toHaveBeenCalled();
    expect(a.aoEncerrar).toHaveBeenCalled();
    expect(a.aoCopiar).toHaveBeenCalled();
  });
  it('confirmando: a pergunta toma o lugar dos botões, com CONTINUAR como saída segura', () => {
    const a = montar({ confirmando: true });
    expect(screen.getByRole('group', { name: 'Confirmar encerramento' }).textContent).toMatch(/perder a imagem/);
    expect(screen.queryByRole('button', { name: 'EXPANDIR' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'CONTINUAR' }));
    expect(a.aoCancelar).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ENCERRAR' }));
    expect(a.aoConfirmar).toHaveBeenCalled();
  });
});
