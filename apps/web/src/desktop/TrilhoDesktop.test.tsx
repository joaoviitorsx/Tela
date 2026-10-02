// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrilhoDesktop } from './TrilhoDesktop.js';

afterEach(cleanup);

describe('TrilhoDesktop', () => {
  it('livre: os três itens respondem, com o rótulo da tela que abrem', () => {
    const aoEscolher = vi.fn();
    render(<TrilhoDesktop ativo="transmitir" travado={false} aoEscolher={aoEscolher} />);

    expect(screen.getByRole('button', { name: /TRANSMITIR/ }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: /CÓDIGO/ }));
    expect(aoEscolher).toHaveBeenCalledWith('canal');
    expect(screen.queryByText('CANAL')).toBeNull();
    expect(document.getElementById('trilho-dica')).toBeNull();
  });

  it('ao vivo: o item vira NO AR e os outros ficam focáveis, com o motivo escrito', () => {
    const aoEscolher = vi.fn();
    render(<TrilhoDesktop ativo="transmitir" travado aoEscolher={aoEscolher} />);

    const noAr = screen.getByRole('button', { name: /NO AR/ });
    expect(noAr.getAttribute('aria-current')).toBe('page');

    const assistir = screen.getByRole('button', { name: /ASSISTIR/ });
    // `aria-disabled`, e não `disabled`: botão desabilitado sai do foco e leva o motivo junto.
    expect((assistir as HTMLButtonElement).disabled).toBe(false);
    expect(assistir.getAttribute('aria-disabled')).toBe('true');

    const dica = document.getElementById(assistir.getAttribute('aria-describedby') ?? '');
    expect(dica?.textContent).toMatch(/ENCERRE PARA SAIR/);

    fireEvent.click(assistir);
    fireEvent.click(screen.getByRole('button', { name: /CÓDIGO/ }));
    expect(aoEscolher).not.toHaveBeenCalled();
  });

  it('rótulos em 10px, num trilho que cabe o maior deles', () => {
    render(<TrilhoDesktop ativo={null} travado={false} aoEscolher={() => undefined} />);
    expect(screen.getByRole('navigation').className).toContain('w-[104px]');
    expect(screen.getByRole('button', { name: /TRANSMITIR/ }).className).toContain('text-[10px]');
  });
});
