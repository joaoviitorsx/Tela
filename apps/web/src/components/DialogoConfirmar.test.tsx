// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogoConfirmar } from './DialogoConfirmar.js';

afterEach(cleanup);

function montar() {
  const aoSeguro = vi.fn();
  const aoAcao = vi.fn();
  const aoClicarNoFundo = vi.fn();
  const seguroRef = createRef<HTMLButtonElement>();
  render(
    <DialogoConfirmar
      titulo="ENCERRAR A TRANSMISSÃO?"
      dialogRef={createRef<HTMLDialogElement>()}
      aoClicarNoFundo={aoClicarNoFundo}
      rotuloSeguro="CONTINUAR NO AR"
      seguroRef={seguroRef}
      aoSeguro={aoSeguro}
      rotuloAcao="ENCERRAR"
      aoAcao={aoAcao}
    >
      2 amigos estão assistindo agora e vão perder a imagem.
    </DialogoConfirmar>,
  );
  return { aoSeguro, aoAcao, seguroRef };
}

describe('DialogoConfirmar', () => {
  it('nomeia o diálogo pelo título e o descreve pelo corpo', () => {
    montar();
    const dialogo = document.querySelector('dialog') as HTMLDialogElement;
    const titulo = document.getElementById(dialogo.getAttribute('aria-labelledby') ?? '');
    const corpo = document.getElementById(dialogo.getAttribute('aria-describedby') ?? '');
    expect(titulo?.textContent).toBe('ENCERRAR A TRANSMISSÃO?');
    expect(corpo?.textContent).toMatch(/2 amigos estão assistindo/);
  });

  it('a saída segura é o primário e a destrutiva é de perigo', () => {
    const { seguroRef } = montar();
    const seguro = screen.getByRole('button', { name: 'CONTINUAR NO AR', hidden: true });
    expect(seguro).toBe(seguroRef.current);
    expect(seguro.className).toContain('tecla-primaria');
    expect(screen.getByRole('button', { name: 'ENCERRAR', hidden: true }).className).toContain('tecla-perigo');
  });

  it('cada botão chama o seu callback', () => {
    const { aoSeguro, aoAcao } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'CONTINUAR NO AR', hidden: true }));
    expect(aoSeguro).toHaveBeenCalledTimes(1);
    expect(aoAcao).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ENCERRAR', hidden: true }));
    expect(aoAcao).toHaveBeenCalledTimes(1);
  });
});
