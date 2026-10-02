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

  it('AJUSTES só aparece com o painel disponível e responde mesmo ao vivo', () => {
    const aoAjustes = vi.fn();
    const { rerender } = render(<TrilhoDesktop ativo="transmitir" travado={false} aoEscolher={() => undefined} />);
    expect(screen.queryByRole('button', { name: /AJUSTES/ })).toBeNull();

    rerender(<TrilhoDesktop ativo="transmitir" travado aoEscolher={() => undefined} aoAjustes={aoAjustes} />);
    const ajustes = screen.getByRole('button', { name: /AJUSTES/ });
    expect(ajustes.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(ajustes);
    expect(aoAjustes).toHaveBeenCalledTimes(1);
  });

  it('D-04: DIAG é um painel, não uma rota: responde ao vivo e só existe com a ação', () => {
    const aoDiagnostico = vi.fn();
    const { rerender } = render(<TrilhoDesktop ativo="transmitir" travado={false} aoEscolher={() => undefined} />);
    expect(screen.queryByRole('button', { name: /DIAG/ })).toBeNull();

    rerender(<TrilhoDesktop ativo="transmitir" travado aoEscolher={() => undefined} aoDiagnostico={aoDiagnostico} />);
    const diag = screen.getByRole('button', { name: /DIAG/ });
    expect(diag.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(diag);
    expect(aoDiagnostico).toHaveBeenCalledTimes(1);
  });

  it('D-05: abaixo de 760px o trilho encolhe para 56px e os nomes ficam só para o leitor de tela', () => {
    render(<TrilhoDesktop ativo={null} travado={false} aoEscolher={() => undefined} aoAjustes={() => undefined} aoDiagnostico={() => undefined} />);
    expect(screen.getByRole('navigation').className).toContain('max-[759px]:w-14');
    for (const nome of ['TRANSMITIR', 'ASSISTIR', 'CÓDIGO', 'DIAG', 'AJUSTES']) {
      const rotulo = screen.getByText(nome);
      expect(rotulo.className).toContain('max-[759px]:sr-only');
    }
  });

  it('D5: ATUALIZAR só existe com aviso, e responde mesmo ao vivo', () => {
    const aoClicar = vi.fn();
    const { rerender } = render(<TrilhoDesktop ativo="transmitir" travado={false} aoEscolher={() => undefined} />);
    expect(screen.queryByRole('button', { name: /atualizar/i })).toBeNull();

    rerender(
      <TrilhoDesktop
        ativo="transmitir"
        travado
        aoEscolher={() => undefined}
        atualizar={{ titulo: 'Versão 0.1.0-beta.9 baixada: reiniciar e atualizar', aoClicar }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /reiniciar e atualizar/ }));
    expect(aoClicar).toHaveBeenCalledTimes(1);
  });
});
