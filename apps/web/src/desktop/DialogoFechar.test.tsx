// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogoFechar } from './DialogoFechar.js';

afterEach(cleanup);

function montar(sobre: { bandeja?: boolean; lembrar?: boolean } = {}) {
  const aoContinuar = vi.fn();
  const aoEncerrar = vi.fn();
  const aoMudarLembrar = vi.fn();
  render(
    <DialogoFechar
      dialogRef={createRef<HTMLDialogElement>()}
      aoClicarNoFundo={() => undefined}
      bandeja={sobre.bandeja ?? true}
      lembrar={sobre.lembrar ?? false}
      aoMudarLembrar={aoMudarLembrar}
      continuarRef={createRef<HTMLButtonElement>()}
      aoContinuar={aoContinuar}
      aoEncerrar={aoEncerrar}
    />,
  );
  return { aoContinuar, aoEncerrar, aoMudarLembrar };
}

describe('DialogoFechar', () => {
  it('a pergunta do plano, com as duas respostas e o lembrar', () => {
    const a = montar();
    const dialogo = document.querySelector('dialog');
    expect(dialogo?.textContent).toContain('CONTINUAR TRANSMITINDO EM SEGUNDO PLANO?');
    fireEvent.click(screen.getByText('CONTINUAR NO AR', { selector: 'button' }));
    fireEvent.click(screen.getByText('ENCERRAR E SAIR', { selector: 'button' }));
    fireEvent.click(screen.getByLabelText(/Lembrar minha escolha/));
    expect(a.aoContinuar).toHaveBeenCalled();
    expect(a.aoEncerrar).toHaveBeenCalled();
    expect(a.aoMudarLembrar).toHaveBeenCalledWith(true);
  });
  it('o texto diz como se controla: bandeja ou janela compacta', () => {
    montar({ bandeja: true });
    expect(document.querySelector('dialog')?.textContent).toMatch(/bandeja do sistema/);
    cleanup();
    montar({ bandeja: false });
    expect(document.querySelector('dialog')?.textContent).toMatch(/faixa compacta/);
  });
});
