// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogoAjustes } from './DialogoAjustes.js';
import type { AjustesDesktop } from './ponte.js';

afterEach(cleanup);

const AJUSTES: AjustesDesktop = {
  iniciarComSistema: false,
  fecharEmSegundoPlano: false,
  sempreNoTopoNoCompacto: false,
  aoFecharAoVivo: 'perguntar',
};

function montar(sobre: { ajustes?: AjustesDesktop | null; bandeja?: boolean; autostartFalhou?: boolean } = {}) {
  const aoMudar = vi.fn();
  render(
    <DialogoAjustes
      dialogRef={createRef<HTMLDialogElement>()}
      aoClicarNoFundo={() => undefined}
      ajustes={sobre.ajustes === undefined ? AJUSTES : sobre.ajustes}
      bandeja={sobre.bandeja ?? true}
      autostartFalhou={sobre.autostartFalhou ?? false}
      aoMudar={aoMudar}
      fecharRef={createRef<HTMLButtonElement>()}
      aoFechar={() => undefined}
    />,
  );
  return aoMudar;
}

describe('DialogoAjustes', () => {
  it('três chaves, cada uma com rótulo associado (acessível por nome) que grava na hora', () => {
    const aoMudar = montar();
    fireEvent.click(screen.getByLabelText('Iniciar com o sistema'));
    fireEvent.click(screen.getByLabelText('Fechar a janela mantém o Tela em segundo plano'));
    fireEvent.click(screen.getByLabelText('Janela compacta sempre no topo'));
    expect(aoMudar).toHaveBeenNthCalledWith(1, { iniciarComSistema: true });
    expect(aoMudar).toHaveBeenNthCalledWith(2, { fecharEmSegundoPlano: true });
    expect(aoMudar).toHaveBeenNthCalledWith(3, { sempreNoTopoNoCompacto: true });
  });
  it('a descrição de cada chave é lida junto (aria-describedby)', () => {
    montar();
    const caixa = screen.getByLabelText('Iniciar com o sistema');
    const id = caixa.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(id)?.textContent).toMatch(/Nunca começa a transmitir sozinho/);
  });
  it('sem bandeja, "fechar = segundo plano" fica desabilitado e explica por quê', () => {
    montar({ ajustes: { ...AJUSTES, fecharEmSegundoPlano: true }, bandeja: false });
    const caixa = screen.getByLabelText('Fechar a janela mantém o Tela em segundo plano') as HTMLInputElement;
    expect(caixa.disabled).toBe(true);
    expect(caixa.checked).toBe(false);
    expect(document.body.textContent).toMatch(/não tem ícone de bandeja/);
  });
  it('antes de o main responder, as chaves ficam travadas', () => {
    montar({ ajustes: null });
    expect((screen.getByLabelText('Iniciar com o sistema') as HTMLInputElement).disabled).toBe(true);
  });
  it('autostart que falhou é dito, e a resposta lembrada pode ser desfeita', () => {
    const aoMudar = montar({ autostartFalhou: true, ajustes: { ...AJUSTES, aoFecharAoVivo: 'segundo-plano' } });
    expect(screen.getByRole('alert', { hidden: true }).textContent).toMatch(/Nada foi alterado/);
    fireEvent.click(screen.getByRole('button', { name: 'PERGUNTAR DE NOVO', hidden: true }));
    expect(aoMudar).toHaveBeenCalledWith({ aoFecharAoVivo: 'perguntar' });
  });
});
