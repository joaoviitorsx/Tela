// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PainelNoAr } from './PainelNoAr.js';

afterEach(cleanup);

const base = { tempo: '00:42', assistindo: 3, capacidade: 50, rota: 'direta', encoder: 'nativo·NVENC' };

describe('PainelNoAr', () => {
  it('mostra o essencial: tempo, n/N, rota e encoder', () => {
    render(<PainelNoAr {...base} aoCompactar={null} aoEncerrar={() => undefined} />);
    const regiao = screen.getByRole('region', { name: 'Transmissão no ar' });
    expect(regiao.textContent).toContain('NO AR');
    expect(regiao.textContent).toContain('00:42');
    expect(regiao.textContent).toContain('3/50');
    expect(regiao.textContent).toContain('direta');
    expect(regiao.textContent).toContain('nativo·NVENC');
  });
  it('ENCERRAR e COMPACTAR chamam seus callbacks; sem compacto o botão some', () => {
    const aoEncerrar = vi.fn();
    const aoCompactar = vi.fn();
    const { rerender } = render(<PainelNoAr {...base} aoCompactar={aoCompactar} aoEncerrar={aoEncerrar} />);
    fireEvent.click(screen.getByRole('button', { name: 'ENCERRAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'COMPACTAR' }));
    expect(aoEncerrar).toHaveBeenCalledTimes(1);
    expect(aoCompactar).toHaveBeenCalledTimes(1);
    rerender(<PainelNoAr {...base} aoCompactar={null} aoEncerrar={aoEncerrar} />);
    expect(screen.queryByRole('button', { name: 'COMPACTAR' })).toBeNull();
  });
});
