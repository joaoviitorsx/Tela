// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConteudoApp } from './ConteudoApp.js';

afterEach(cleanup);

const URL_LANCAMENTOS = 'https://github.com/joaoviitorsx/Tela/releases';

describe('ConteudoApp', () => {
  it('Windows e Linux levam à página de lançamentos, em aba nova', () => {
    render(<ConteudoApp urlDosLancamentos={URL_LANCAMENTOS} menu={null} posicao="1/5" />);

    for (const nome of [/WINDOWS/, /LINUX/]) {
      const link = screen.getByRole('link', { name: nome });
      expect(link.getAttribute('href')).toBe(URL_LANCAMENTOS);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
    }
    expect(screen.getByRole('link', { name: /LINUX/ }).textContent).toMatch(/APPIMAGE · DEB · RPM/);
  });

  it('avisa do SmartScreen e que é um beta, sem dizer que não foi lançado', () => {
    const { container } = render(<ConteudoApp urlDosLancamentos={URL_LANCAMENTOS} menu={null} posicao="1/5" />);
    const texto = container.textContent ?? '';
    expect(texto).toMatch(/SmartScreen/);
    expect(texto).toMatch(/Mais informações → Executar assim mesmo/);
    expect(texto).toMatch(/beta público/);
    expect(texto).not.toMatch(/EM BREVE|Ainda não foi lançado/);
  });
});
