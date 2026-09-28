// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMenuOsd } from './use-menu-osd.js';

afterEach(cleanup);

const IDS = ['resolucao', 'rede', 'volume'] as const;

function Menu({
  aoAjustar,
  aoConfirmar,
  global = false,
}: {
  aoAjustar: (id: string, d: -1 | 1) => void;
  aoConfirmar?: () => void;
  global?: boolean;
}) {
  const menu = useMenuOsd({ ids: IDS, aoAjustar, ...(aoConfirmar ? { aoConfirmar } : {}), global });
  return (
    <div>
      <button type="button">antes</button>
      <div role="group" aria-label="menu" {...menu.propsContainer}>
        {IDS.map((id) => (
          <div key={id} role="spinbutton" aria-label={id} {...menu.propsLinha(id)}>
            {id}
          </div>
        ))}
      </div>
      <output>{menu.posicao}</output>
    </div>
  );
}

const linha = (id: string) => screen.getByRole('spinbutton', { name: id });

describe('useMenuOsd', () => {
  it('só uma linha entra na ordem de tabulação (roving focus)', () => {
    render(<Menu aoAjustar={() => undefined} />);
    expect(linha('resolucao').tabIndex).toBe(0);
    expect(linha('rede').tabIndex).toBe(-1);
    expect(linha('volume').tabIndex).toBe(-1);
  });

  it('↑↓ movem o foco DOM e a posição, com volta nas pontas', () => {
    render(<Menu aoAjustar={() => undefined} />);
    linha('resolucao').focus();

    fireEvent.keyDown(linha('resolucao'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(linha('rede'));
    expect(linha('rede').tabIndex).toBe(0);
    expect(linha('resolucao').tabIndex).toBe(-1);
    expect(screen.getByRole('status').textContent).toBe('2/3');

    fireEvent.keyDown(linha('rede'), { key: 'ArrowUp' });
    fireEvent.keyDown(linha('resolucao'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(linha('volume'));
    expect(screen.getByRole('status').textContent).toBe('3/3');

    fireEvent.keyDown(linha('volume'), { key: 'Home' });
    expect(document.activeElement).toBe(linha('resolucao'));
    fireEvent.keyDown(linha('resolucao'), { key: 'End' });
    expect(document.activeElement).toBe(linha('volume'));
  });

  it('←→ ajustam a linha focada e não mexem no foco', () => {
    const aoAjustar = vi.fn();
    render(<Menu aoAjustar={aoAjustar} />);
    linha('rede').focus();

    fireEvent.keyDown(linha('rede'), { key: 'ArrowRight' });
    fireEvent.keyDown(linha('rede'), { key: 'ArrowLeft' });

    expect(aoAjustar).toHaveBeenNthCalledWith(1, 'rede', 1);
    expect(aoAjustar).toHaveBeenNthCalledWith(2, 'rede', -1);
    expect(document.activeElement).toBe(linha('rede'));
  });

  it('Enter na linha confirma; com modificador, deixa passar', () => {
    const aoConfirmar = vi.fn();
    render(<Menu aoAjustar={() => undefined} aoConfirmar={aoConfirmar} />);
    linha('resolucao').focus();

    fireEvent.keyDown(linha('resolucao'), { key: 'Enter', ctrlKey: true });
    expect(aoConfirmar).not.toHaveBeenCalled();

    fireEvent.keyDown(linha('resolucao'), { key: 'Enter' });
    expect(aoConfirmar).toHaveBeenCalledTimes(1);
  });

  it('global: com o foco no corpo, ↓ entra no menu e → ajusta a primeira linha', () => {
    const aoAjustar = vi.fn();
    render(<Menu aoAjustar={aoAjustar} global />);

    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(linha('resolucao'));

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(aoAjustar).toHaveBeenCalledWith('resolucao', 1);
  });

  it('global: não rouba a tecla de quem está num controle', () => {
    const aoAjustar = vi.fn();
    render(<Menu aoAjustar={aoAjustar} global />);
    const botao = screen.getByRole('button', { name: 'antes' });
    botao.focus();

    fireEvent.keyDown(botao, { key: 'ArrowRight' });

    expect(aoAjustar).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(botao);
  });

  it('sem global, as setas fora do menu não fazem nada', () => {
    const aoAjustar = vi.fn();
    render(<Menu aoAjustar={aoAjustar} />);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(aoAjustar).not.toHaveBeenCalled();
  });
});
