// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDialogo } from './use-dialogo.js';

afterEach(cleanup);

function Exemplo({ aberto, aoFechar }: { aberto: boolean; aoFechar: () => void }) {
  const d = useDialogo(aberto, aoFechar);
  return (
    <dialog ref={d.ref} onClick={d.aoClicar} data-testid="dialogo">
      <button type="button">dentro</button>
    </dialog>
  );
}

const dialogo = (c: HTMLElement) => c.querySelector('dialog') as HTMLDialogElement;

describe('useDialogo', () => {
  it('abre e fecha o <dialog> conforme o estado', () => {
    const { container, rerender } = render(<Exemplo aberto={false} aoFechar={() => undefined} />);
    expect(dialogo(container).open).toBe(false);

    rerender(<Exemplo aberto aoFechar={() => undefined} />);
    expect(dialogo(container).open).toBe(true);

    rerender(<Exemplo aberto={false} aoFechar={() => undefined} />);
    expect(dialogo(container).open).toBe(false);
  });

  it('quando o NAVEGADOR fecha (Esc), avisa para o estado acompanhar', () => {
    const aoFechar = vi.fn();
    const { container } = render(<Exemplo aberto aoFechar={aoFechar} />);

    act(() => {
      dialogo(container).dispatchEvent(new Event('close'));
    });

    expect(aoFechar).toHaveBeenCalledTimes(1);
  });

  it('clique no fundo fecha; clique no conteúdo não', () => {
    const aoFechar = vi.fn();
    const { container, getByText } = render(<Exemplo aberto aoFechar={aoFechar} />);

    act(() => getByText('dentro').click());
    expect(aoFechar).not.toHaveBeenCalled();

    act(() => dialogo(container).click());
    expect(aoFechar).toHaveBeenCalledTimes(1);
  });

  it('dá o foco inicial ao elemento pedido ao abrir (a saída segura)', () => {
    const foco = createRef<HTMLButtonElement>();
    function ComFoco({ aberto }: { aberto: boolean }) {
      const d = useDialogo(aberto, () => undefined, foco);
      return (
        <dialog ref={d.ref}>
          <button type="button">perigo</button>
          <button type="button" ref={foco}>
            seguro
          </button>
        </dialog>
      );
    }
    const { rerender, getByText } = render(<ComFoco aberto={false} />);
    rerender(<ComFoco aberto />);
    expect(document.activeElement).toBe(getByText('seguro'));
  });
});
