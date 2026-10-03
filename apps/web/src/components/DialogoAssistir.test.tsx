// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogoAssistir } from './DialogoAssistir.js';

afterEach(cleanup);

function montar(props: Partial<Parameters<typeof DialogoAssistir>[0]> = {}) {
  const dialogRef = createRef<HTMLDialogElement>();
  const aoEnviar = vi.fn();
  const aoMudar = vi.fn();
  const aoCancelar = vi.fn();
  render(
    <DialogoAssistir
      dialogRef={dialogRef}
      aoClicarNoFundo={() => undefined}
      inputRef={createRef<HTMLInputElement>()}
      valor=""
      aoMudar={aoMudar}
      invalido={false}
      aoEnviar={aoEnviar}
      aoCancelar={aoCancelar}
      {...props}
    />,
  );
  dialogRef.current?.setAttribute('open', '');
  return { aoEnviar, aoMudar, aoCancelar };
}

describe('DialogoAssistir', () => {
  it('um campo nomeado e as duas teclas', () => {
    montar();
    expect(screen.getByLabelText('LINK OU NOME DO CANAL')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ASSISTIR' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'CANCELAR' })).toBeTruthy();
  });
  it('digitar chama aoMudar; Enter/ASSISTIR envia pelo formulário', () => {
    const { aoMudar, aoEnviar } = montar({ valor: 'joao' });
    fireEvent.change(screen.getByLabelText('LINK OU NOME DO CANAL'), { target: { value: 'tela.gg/maria' } });
    expect(aoMudar).toHaveBeenCalledWith('tela.gg/maria');
    fireEvent.click(screen.getByRole('button', { name: 'ASSISTIR' }));
    expect(aoEnviar).toHaveBeenCalledOnce();
  });
  it('inválido: o campo é marcado e a frase diz o que colar', () => {
    montar({ invalido: true });
    expect(screen.getByLabelText('LINK OU NOME DO CANAL').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('status').textContent).toMatch(/Não achei um canal/);
  });
  it('CANCELAR e × fecham', () => {
    const { aoCancelar } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'CANCELAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(aoCancelar).toHaveBeenCalledTimes(2);
  });

  it('RECENTES viram teclas; tocar escolhe o canal', () => {
    const aoEscolher = vi.fn();
    montar({ recentes: ['amigo', 'joao'], aoEscolher });
    fireEvent.click(screen.getByRole('button', { name: 'Assistir amigo' }));
    expect(aoEscolher).toHaveBeenCalledWith('amigo');
    expect(screen.getByRole('status').textContent).toContain('canal recente');
  });

  it('sem recentes, nada de seção RECENTES', () => {
    montar({ recentes: [], aoEscolher: vi.fn() });
    expect(screen.queryByText('RECENTES')).toBeNull();
  });
});
