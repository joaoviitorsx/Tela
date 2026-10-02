// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FonteNoSeletor, SeletorDeFontes } from './SeletorDeFontes.js';

afterEach(cleanup);

const FONTES: readonly FonteNoSeletor[] = [
  { id: 'screen:0:0', nome: 'TELA INTEIRA', tipo: 'tela', miniatura: 'data:image/jpeg;base64,AA==', icone: null },
  { id: 'window:7:0', nome: 'Hades II', tipo: 'janela', miniatura: null, icone: 'data:image/png;base64,BB==' },
  { id: 'window:8:0', nome: 'Discord', tipo: 'janela', miniatura: 'data:image/jpeg;base64,CC==', icone: null },
];

function montar(props: Partial<Parameters<typeof SeletorDeFontes>[0]> = {}) {
  const aoMudarAba = vi.fn();
  const aoEscolher = vi.fn();
  const aoCancelar = vi.fn();
  const ref = createRef<HTMLDialogElement>();
  const utils = render(
    <SeletorDeFontes
      dialogRef={ref}
      aoClicarNoFundo={() => undefined}
      aba="telas"
      fontes={FONTES}
      carregando={false}
      avisoDeJanela={null}
      aoMudarAba={aoMudarAba}
      aoEscolher={aoEscolher}
      aoCancelar={aoCancelar}
      {...props}
    />,
  );
  // O `<dialog>` fechado é inerte para o testing-library: abre como o hook abriria.
  ref.current?.setAttribute('open', '');
  return { ...utils, aoMudarAba, aoEscolher, aoCancelar };
}

describe('SeletorDeFontes', () => {
  it('na aba TELAS só as telas aparecem, com miniatura; a aba está marcada', () => {
    montar();
    expect(screen.getByRole('tab', { name: 'TELAS' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'TELA INTEIRA' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hades II' })).toBeNull();
    expect(screen.getByRole('button', { name: 'TELA INTEIRA' }).querySelector('img')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,AA==',
    );
  });

  it('na aba JOGO E JANELAS as janelas aparecem, com ícone e "SEM PRÉVIA" quando falta miniatura', () => {
    montar({ aba: 'janelas' });
    const hades = screen.getByRole('button', { name: 'Hades II' });
    expect(hades.textContent).toContain('SEM PRÉVIA');
    expect(hades.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BB==');
    expect(screen.getByRole('button', { name: 'Discord' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'TELA INTEIRA' })).toBeNull();
  });

  it('clicar numa miniatura escolhe pelo id; o × cancela', () => {
    const m = montar({ aba: 'janelas' });
    fireEvent.click(screen.getByRole('button', { name: 'Discord' }));
    expect(m.aoEscolher).toHaveBeenCalledWith('window:8:0');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(m.aoCancelar).toHaveBeenCalledTimes(1);
  });

  it('as abas trocam por clique e por ←/→', () => {
    const m = montar();
    fireEvent.click(screen.getByRole('tab', { name: 'JOGO E JANELAS' }));
    expect(m.aoMudarAba).toHaveBeenCalledWith('janelas');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(m.aoMudarAba).toHaveBeenLastCalledWith('janelas');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(m.aoMudarAba).toHaveBeenLastCalledWith('janelas');
    // Só a aba ativa está na ordem do Tab; as outras chegam pelas setas.
    expect(screen.getByRole('tab', { name: 'TELAS' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'JOGO E JANELAS' }).getAttribute('tabindex')).toBe('-1');
  });

  it('o aviso de janela só aparece na aba de janelas, e só quando existe', () => {
    const { rerender } = montar({ aba: 'janelas', avisoDeJanela: 'Sem som do sistema aqui.' });
    expect(screen.getByText(/Sem som do sistema aqui/)).toBeTruthy();
    rerender(
      <SeletorDeFontes
        dialogRef={createRef()}
        aoClicarNoFundo={() => undefined}
        aba="telas"
        fontes={FONTES}
        carregando={false}
        avisoDeJanela="Sem som do sistema aqui."
        aoMudarAba={() => undefined}
        aoEscolher={() => undefined}
        aoCancelar={() => undefined}
      />,
    );
    expect(screen.queryByText(/Sem som do sistema aqui/)).toBeNull();
  });

  it('carregando sem fontes diz PROCURANDO; vazio diz que não achou', () => {
    const { rerender } = montar({ fontes: [], carregando: true });
    expect(screen.getByText('PROCURANDO…')).toBeTruthy();
    expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('true');
    rerender(
      <SeletorDeFontes
        dialogRef={createRef()}
        aoClicarNoFundo={() => undefined}
        aba="janelas"
        fontes={[]}
        carregando={false}
        avisoDeJanela={null}
        aoMudarAba={() => undefined}
        aoEscolher={() => undefined}
        aoCancelar={() => undefined}
      />,
    );
    expect(screen.getByText('NENHUMA JANELA ABERTA')).toBeTruthy();
  });
});
