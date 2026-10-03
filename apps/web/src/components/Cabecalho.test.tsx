// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Cabecalho } from './Cabecalho.js';

afterEach(cleanup);

describe('Cabecalho', () => {
  it('com repositório: link do GitHub numa aba nova, sem vazar a origem', () => {
    render(<Cabecalho repositorio="https://github.com/joaoviitorsx/Tela" />);
    const link = screen.getByRole('link', { name: 'Código no GitHub' });
    expect(link.getAttribute('href')).toBe('https://github.com/joaoviitorsx/Tela');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('sem repositório: sem link', () => {
    render(<Cabecalho />);
    expect(screen.queryByRole('link', { name: 'Código no GitHub' })).toBeNull();
  });
});
