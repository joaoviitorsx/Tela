// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MolduraDoQuadro } from './MolduraDoQuadro.js';

afterEach(cleanup);

const props = {
  canal: 'ana',
  aoVivo: true,
  aviso: null,
  pausa: null,
  congelado: null,
  comToque: false,
  rotuloNoTopo: false,
  tamanho: null,
  aoTrocar: () => undefined,
  aoFechar: () => undefined,
};

describe('MolduraDoQuadro', () => {
  it('o quadro inteiro troca; o X fecha', () => {
    const aoTrocar = vi.fn();
    const aoFechar = vi.fn();
    render(<MolduraDoQuadro {...props} aoTrocar={aoTrocar} aoFechar={aoFechar} />);
    fireEvent.click(screen.getByRole('button', { name: 'Trocar para ana (T)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar ana (X)' }));
    expect(aoTrocar).toHaveBeenCalledOnce();
    expect(aoFechar).toHaveBeenCalledOnce();
  });

  it('pausada: diz o porquê e oferece RETOMAR', () => {
    const aoRetomar = vi.fn();
    const { container } = render(
      <MolduraDoQuadro {...props} pausa={{ texto: 'PAUSADA · SUA REDE NÃO SEGURA DUAS', aoRetomar }} />,
    );
    expect(container.textContent).toContain('PAUSADA · SUA REDE NÃO SEGURA DUAS');
    fireEvent.click(screen.getByRole('button', { name: 'RETOMAR' }));
    expect(aoRetomar).toHaveBeenCalledOnce();
  });

  it('o tamanho só existe quando pedido', () => {
    const { rerender } = render(<MolduraDoQuadro {...props} />);
    expect(screen.queryByRole('button', { name: /Tamanho/ })).toBeNull();
    rerender(<MolduraDoQuadro {...props} tamanho={{ rotulo: 'M', aoMudar: () => undefined }} />);
    expect(screen.getByRole('button', { name: 'Tamanho do quadro: M' })).toBeTruthy();
  });
});
