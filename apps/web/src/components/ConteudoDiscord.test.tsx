// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConteudoDiscord, type PropsDoAvisoAutomatico } from './ConteudoDiscord.js';

afterEach(cleanup);

const INSTALAR = 'https://discord.com/oauth2/authorize?client_id=1545598563994701824';

const AVISO: PropsDoAvisoAutomatico = {
  salvo: null,
  ativo: false,
  status: null,
  entrada: '',
  aoMudar: () => undefined,
  erroEntrada: false,
  aoSalvar: () => undefined,
  aoTestar: () => undefined,
  testando: false,
  aoLigar: () => undefined,
  aoRemover: () => undefined,
  aoAvisarAgora: null,
};

describe('ConteudoDiscord', () => {
  it('instalar abre o Discord em aba nova', () => {
    render(<ConteudoDiscord urlInstalar={INSTALAR} canal="soumbra" copiado={false} aoCopiar={() => undefined} aviso={AVISO} />);
    const link = screen.getByRole('link', { name: /ADICIONAR O TELA AO DISCORD/ });
    expect(link.getAttribute('href')).toBe(INSTALAR);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('mostra o comando com o nome do canal e copia só o nome', () => {
    const aoCopiar = vi.fn();
    const { container, rerender } = render(
      <ConteudoDiscord urlInstalar={INSTALAR} canal="soumbra" copiado={false} aoCopiar={aoCopiar} aviso={AVISO} />,
    );
    expect(container.querySelector('code')?.textContent).toBe('/tela canal:soumbra');
    fireEvent.click(screen.getByRole('button', { name: 'COPIAR NOME' }));
    expect(aoCopiar).toHaveBeenCalledOnce();

    rerender(<ConteudoDiscord urlInstalar={INSTALAR} canal="soumbra" copiado aoCopiar={aoCopiar} aviso={AVISO} />);
    expect(screen.getByRole('button', { name: 'NOME COPIADO' })).toBeTruthy();
  });

  it('diz o que o app não faz', () => {
    const { container } = render(
      <ConteudoDiscord urlInstalar={INSTALAR} canal="soumbra" copiado={false} aoCopiar={() => undefined} aviso={AVISO} />,
    );
    expect(container.textContent).toMatch(/não lê mensagens, não entra em call e não guarda nada/);
  });

  it('aviso automático: sem webhook pede a URL; com webhook, liga/desliga, testa e remove', () => {
    const aoSalvar = vi.fn();
    const { rerender } = render(
      <ConteudoDiscord urlInstalar={INSTALAR} canal="soumbra" copiado={false} aoCopiar={() => undefined} aviso={{ ...AVISO, aoSalvar }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'SALVAR' }));
    expect(aoSalvar).toHaveBeenCalledOnce();

    const aoLigar = vi.fn();
    const aoAvisarAgora = vi.fn();
    rerender(
      <ConteudoDiscord
        urlInstalar={INSTALAR}
        canal="soumbra"
        copiado={false}
        aoCopiar={() => undefined}
        aviso={{ ...AVISO, salvo: '…/webhooks/123/abcd••••', ativo: true, aoLigar, aoAvisarAgora }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'AVISO LIGADO' }));
    expect(aoLigar).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'AVISAR AGORA' }));
    expect(aoAvisarAgora).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'TESTAR' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'REMOVER' })).toBeTruthy();
  });
});
