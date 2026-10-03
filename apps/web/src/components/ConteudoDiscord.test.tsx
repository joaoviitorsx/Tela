// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConteudoDiscord } from './ConteudoDiscord.js';

afterEach(cleanup);

const INSTALAR = 'https://discord.com/oauth2/authorize?client_id=1545598563994701824';

describe('ConteudoDiscord', () => {
  it('instalar abre o Discord em aba nova', () => {
    render(<ConteudoDiscord urlInstalar={INSTALAR} canal="soumbra" copiado={false} aoCopiar={() => undefined} />);
    const link = screen.getByRole('link', { name: /ADICIONAR O TELA AO DISCORD/ });
    expect(link.getAttribute('href')).toBe(INSTALAR);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('mostra o comando com o nome do canal e copia só o nome', () => {
    const aoCopiar = vi.fn();
    const { container, rerender } = render(
      <ConteudoDiscord urlInstalar={INSTALAR} canal="soumbra" copiado={false} aoCopiar={aoCopiar} />,
    );
    expect(container.querySelector('code')?.textContent).toBe('/tela canal:soumbra');
    fireEvent.click(screen.getByRole('button', { name: 'COPIAR NOME' }));
    expect(aoCopiar).toHaveBeenCalledOnce();

    rerender(<ConteudoDiscord urlInstalar={INSTALAR} canal="soumbra" copiado aoCopiar={aoCopiar} />);
    expect(screen.getByRole('button', { name: 'NOME COPIADO' })).toBeTruthy();
  });

  it('diz o que o app não faz', () => {
    const { container } = render(
      <ConteudoDiscord urlInstalar={INSTALAR} canal="soumbra" copiado={false} aoCopiar={() => undefined} />,
    );
    expect(container.textContent).toMatch(/não lê mensagens, não entra em call e não guarda nada/);
  });
});
